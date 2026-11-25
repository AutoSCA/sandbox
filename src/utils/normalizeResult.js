import fs from 'fs/promises';
import { saveJson } from './saveJson.js';

const SEVERITY_ORDER = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// 도구별로 제각각인 심각도 표기를 통일 (MODERATE, Negligible 등)
function normalizeSeverity(severity, score) {
    const value = String(severity ?? '').toUpperCase();

    if (value === 'MODERATE') return 'MEDIUM';
    if (value === 'NEGLIGIBLE') return 'LOW';
    if (SEVERITY_ORDER.includes(value)) return value;

    // 심각도 표기가 없으면 CVSS 점수로 판단
    if (score >= 9) return 'CRITICAL';
    if (score >= 7) return 'HIGH';
    if (score >= 4) return 'MEDIUM';
    if (score > 0) return 'LOW';
    return 'UNKNOWN';
}

function higherSeverity(a, b) {
    return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function toScore(value) {
    const score = parseFloat(value);
    return Number.isNaN(score) ? null : score;
}

function maxScore(scores) {
    const valid = scores.map(toScore).filter((score) => score !== null);
    return valid.length > 0 ? Math.max(...valid) : null;
}

function unique(list) {
    return [...new Set(list.filter(Boolean))];
}

function isTruncatedText(text) {
    const s = String(text ?? '').trim();
    return /(?:\.\.\.|…)$/.test(s);
}

// 더 풍부하고 잘리지 않은 설명을 우선 선택
function pickRicherDescription(current, candidate) {
    const a = String(current ?? '').trim();
    const b = String(candidate ?? '').trim();
    if (!b) return a || null;
    if (!a) return b;
    const aTrunc = isTruncatedText(a);
    const bTrunc = isTruncatedText(b);
    if (aTrunc && !bTrunc) return b;
    if (!aTrunc && bTrunc) return a;
    return b.length > a.length ? b : a;
}

// Trivy 의 중복 접두 제목(예: "undici: undici: ...")보다 깔끔한 제목 우선 선택
function hasDuplicatedPrefix(title) {
    return /^([a-z0-9@._/-]+):\s*\1:/i.test(String(title ?? '').trim());
}

function pickRicherTitle(current, candidate) {
    const a = String(current ?? '').trim();
    const b = String(candidate ?? '').trim();
    if (!b) return a || null;
    if (!a) return b;
    if (hasDuplicatedPrefix(a) && !hasDuplicatedPrefix(b)) return b;
    return a;
}

const OSV_API_BASE = 'https://api.osv.dev/v1/vulns';
const OSV_ENRICH_CONCURRENCY = 10;
const OSV_REQUEST_TIMEOUT_MS = 5000;
const OSV_TOTAL_BUDGET_MS = 25000;
const RICH_ADVISORY_RE = /^(?:GHSA-|RUSTSEC-|PYSEC-|GO-)/i;

function needsOsvEnrichment(vuln) {
    const desc = String(vuln.description ?? '').trim();
    if (!desc || isTruncatedText(desc)) return true;
    if (!vuln.detectedBy.includes('osv-scanner') && desc.length < 400) return true;
    if (!vuln.title || hasDuplicatedPrefix(vuln.title) || !vuln.publishedAt) return true;
    return false;
}

async function fetchOsvVulnById(id, cache, deadline) {
    const cleanId = String(id ?? '').trim();
    if (!cleanId) return null;
    if (cache.has(cleanId)) return cache.get(cleanId);

    const remaining = deadline - Date.now();
    if (remaining <= 300) return null;

    const promise = (async () => {
        try {
            const timeoutMs = Math.min(OSV_REQUEST_TIMEOUT_MS, remaining);
            const res = await fetch(`${OSV_API_BASE}/${encodeURIComponent(cleanId)}`, {
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!res.ok) return null;
            return await res.json();
        }
        catch {
            return null;
        }
    })();

    cache.set(cleanId, promise);
    return promise;
}

// CVE 레코드의 aliases 에 GHSA/RUSTSEC/PYSEC/GO 권고가 있으면 함께 조회해 가장 풍부한 원문 선택
async function resolveBestOsvRecord(vuln, cache, deadline) {
    const allIds = unique([vuln.id, ...(vuln.aliases ?? [])]);
    const preferredIds = [
        ...allIds.filter((id) => RICH_ADVISORY_RE.test(id)),
        ...allIds.filter((id) => !RICH_ADVISORY_RE.test(id))
    ];

    let best = null;
    for (const id of preferredIds) {
        if (Date.now() >= deadline) break;
        const record = await fetchOsvVulnById(id, cache, deadline);
        if (!record) continue;

        if (!best || String(record.details ?? '').length > String(best.details ?? '').length) {
            best = record;
        }

        // 이미 GHSA/RUSTSEC 등 풍부한 권고를 얻었으면 추가 조회 생략
        if (RICH_ADVISORY_RE.test(record.id ?? id) && String(record.details ?? '').length >= 200) {
            break;
        }

        // CVE 조회 결과에 GHSA 등 더 상세한 별칭이 있으면 1회 추가 조회
        const richAlias = (record.aliases ?? []).find((alias) => RICH_ADVISORY_RE.test(alias));
        if (richAlias && richAlias !== id && Date.now() < deadline) {
            const aliasRecord = await fetchOsvVulnById(richAlias, cache, deadline);
            if (aliasRecord && String(aliasRecord.details ?? '').length >= String(best.details ?? '').length) {
                best = aliasRecord;
                break;
            }
        }

        if (String(best.details ?? '').length >= 200) break;
    }

    return best;
}

// Trivy/Grype 단독 탐지 등 설명이 부족하거나 잘린 취약점을 OSV 공개 API 로 보강
async function enrichWithOsv(vulnerabilities) {
    const targets = vulnerabilities.filter(needsOsvEnrichment);
    if (targets.length === 0) return;

    const cache = new Map();
    const deadline = Date.now() + OSV_TOTAL_BUDGET_MS;
    let cursor = 0;

    const worker = async () => {
        while (cursor < targets.length && Date.now() < deadline) {
            const vuln = targets[cursor++];
            const record = await resolveBestOsvRecord(vuln, cache, deadline);
            if (!record) continue;

            const nextDesc = pickRicherDescription(vuln.description, record.details);
            if (nextDesc) vuln.description = nextDesc;

            const nextTitle = pickRicherTitle(vuln.title, record.summary);
            if (nextTitle) vuln.title = nextTitle;

            if (!vuln.publishedAt && record.published) {
                vuln.publishedAt = record.published;
            }

            const recordIds = unique([record.id, ...(record.aliases ?? [])]).filter((id) => id !== vuln.id);
            if (recordIds.length > 0) {
                vuln.aliases = unique([...vuln.aliases, ...recordIds]);
            }

            const recordCwes = record.database_specific?.cwe_ids ?? [];
            if (recordCwes.length > 0) {
                vuln.cwes = unique([...vuln.cwes, ...recordCwes]);
            }

            const recordRefs = (record.references ?? []).map((ref) => ref?.url).filter(Boolean);
            if (recordRefs.length > 0) {
                // OSV 의 GitHub Advisory/Commit/Release 링크가 앞쪽에 오도록 병합
                vuln.references = unique([...recordRefs, ...vuln.references]);
            }
        }
    };

    const poolSize = Math.min(OSV_ENRICH_CONCURRENCY, targets.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
}

// 파일이 없거나 경로가 없으면 null (해당 도구는 건너뜀)
async function readJson(filePath) {
    if (!filePath) {
        return { data: null, skipped: '경로가 지정되지 않았습니다.' };
    }

    try {
        const text = await fs.readFile(filePath, 'utf-8');
        return { data: JSON.parse(text), skipped: null };
    }
    catch (error) {
        return {
            data: null,
            skipped: error.code === 'ENOENT' ? '파일이 존재하지 않습니다.' : error.message
        };
    }
}

// 도구별 결과를 공통 형식(finding)의 배열로 변환
function parseOsv(json) {
    const findings = [];

    for (const result of json?.results ?? []) {
        for (const pkg of result.packages ?? []) {
            for (const vuln of pkg.vulnerabilities ?? []) {
                const group = (pkg.groups ?? []).find((g) => g.ids?.includes(vuln.id));
                const score = toScore(group?.max_severity);
                const fixedVersions = (vuln.affected ?? [])
                    .filter((affected) => affected.package?.name === pkg.package.name)
                    .flatMap((affected) => affected.ranges ?? [])
                    .flatMap((range) => range.events ?? [])
                    .map((event) => event.fixed);

                findings.push({
                    tool: 'osv-scanner',
                    ids: unique([vuln.id, ...(vuln.aliases ?? [])]),
                    package: {
                        name: pkg.package.name,
                        version: pkg.package.version,
                        ecosystem: String(pkg.package.ecosystem ?? '').toLowerCase()
                    },
                    severity: normalizeSeverity(vuln.database_specific?.severity, score),
                    cvssScore: score,
                    fixedVersions: unique(fixedVersions),
                    title: vuln.summary ?? null,
                    description: vuln.details ?? null,
                    cwes: vuln.database_specific?.cwe_ids ?? [],
                    references: (vuln.references ?? []).map((ref) => ref.url),
                    publishedAt: vuln.published ?? null,
                    files: [result.source?.path]
                });
            }
        }
    }

    return findings;
}

function parseGrype(json) {
    const findings = [];

    for (const match of json?.matches ?? []) {
        const vuln = match.vulnerability;
        const related = match.relatedVulnerabilities ?? [];
        const all = [vuln, ...related];
        const score = maxScore(all.flatMap((v) => (v.cvss ?? []).map((cvss) => cvss.metrics?.baseScore)));

        findings.push({
            tool: 'grype',
            ids: unique(all.map((v) => v.id)),
            package: {
                name: match.artifact.name,
                version: match.artifact.version,
                ecosystem: String(match.artifact.type ?? '').toLowerCase()
            },
            severity: normalizeSeverity(vuln.severity, score),
            cvssScore: score,
            fixedVersions: vuln.fix?.versions ?? [],
            title: null,
            description: all.map((v) => v.description).find(Boolean) ?? null,
            cwes: unique(all.flatMap((v) => (v.cwes ?? []).map((cwe) => cwe.cwe))),
            references: unique([vuln.dataSource, ...all.flatMap((v) => v.urls ?? [])]),
            publishedAt: null,
            files: (match.artifact.locations ?? []).map((location) => location.path)
        });
    }

    return findings;
}

function parseTrivy(json) {
    const findings = [];

    for (const result of json?.Results ?? []) {
        for (const vuln of result.Vulnerabilities ?? []) {
            const score = maxScore(
                Object.values(vuln.CVSS ?? {}).flatMap((cvss) => [cvss.V3Score, cvss.V40Score, cvss.V2Score])
            );

            findings.push({
                tool: 'trivy',
                ids: unique([vuln.VulnerabilityID, ...(vuln.VendorIDs ?? [])]),
                package: {
                    name: vuln.PkgName,
                    version: vuln.InstalledVersion,
                    ecosystem: String(result.Type ?? '').toLowerCase()
                },
                severity: normalizeSeverity(vuln.Severity, score),
                cvssScore: score,
                fixedVersions: vuln.FixedVersion ? vuln.FixedVersion.split(',').map((v) => v.trim()) : [],
                title: vuln.Title ?? null,
                description: vuln.Description ?? null,
                cwes: vuln.CweIDs ?? [],
                references: unique([vuln.PrimaryURL, ...(vuln.References ?? [])]),
                publishedAt: vuln.PublishedDate ?? null,
                files: [result.Target]
            });
        }
    }

    return findings;
}

// 같은 패키지(이름+버전)에서 취약점 ID(CVE, GHSA 등)가 하나라도 겹치면 동일한 취약점으로 병합
function mergeFindings(findings) {
    const merged = [];
    const index = new Map();

    for (const finding of findings) {
        const packageKey = `${finding.package.ecosystem}|${finding.package.name.toLowerCase()}@${finding.package.version}`;
        const found = finding.ids.map((id) => index.get(`${packageKey}|${id}`)).find(Boolean);

        if (!found) {
            const entry = {
                ids: new Set(finding.ids),
                package: finding.package,
                severity: finding.severity,
                cvssScore: finding.cvssScore,
                fixedVersions: new Set(finding.fixedVersions),
                title: finding.title,
                description: finding.description,
                cwes: new Set(finding.cwes),
                references: new Set(finding.references.filter(Boolean)),
                publishedAt: finding.publishedAt,
                files: new Set(finding.files.filter(Boolean)),
                detectedBy: [finding.tool],
                sources: { [finding.tool]: { id: finding.ids[0], severity: finding.severity, cvssScore: finding.cvssScore } }
            };
            merged.push(entry);
            finding.ids.forEach((id) => index.set(`${packageKey}|${id}`, entry));
            continue;
        }

        // 이미 있는 취약점이면 정보를 합침 (심각도/점수는 가장 높은 값 기준)
        finding.ids.forEach((id) => {
            found.ids.add(id);
            index.set(`${packageKey}|${id}`, found);
        });
        found.severity = higherSeverity(found.severity, finding.severity);
        found.cvssScore = maxScore([found.cvssScore, finding.cvssScore]);
        finding.fixedVersions.forEach((version) => found.fixedVersions.add(version));
        finding.cwes.forEach((cwe) => found.cwes.add(cwe));
        finding.references.filter(Boolean).forEach((url) => found.references.add(url));
        finding.files.filter(Boolean).forEach((file) => found.files.add(file));
        found.title = pickRicherTitle(found.title, finding.title);
        found.description = pickRicherDescription(found.description, finding.description);
        if (finding.publishedAt && (!found.publishedAt || finding.publishedAt < found.publishedAt)) {
            found.publishedAt = finding.publishedAt;
        }
        if (!found.detectedBy.includes(finding.tool)) {
            found.detectedBy.push(finding.tool);
        }
        found.sources[finding.tool] ??= { id: finding.ids[0], severity: finding.severity, cvssScore: finding.cvssScore };
    }

    return merged;
}

// 도구별로 절대경로/상대경로가 섞여서 나오므로 상대경로(또는 파일명)로 통일
function toRelativeFiles(files, allRelativeFiles = []) {
    const normalized = files.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''));

    return unique(normalized.map((file) => {
        if (!/^(?:[A-Za-z]:\/|\/)/.test(file)) return file;
        const matched = allRelativeFiles.find((rel) => file.endsWith(`/${rel}`));
        return matched ?? file.split('/').pop();
    }));
}

// 최종 출력 형식으로 정리 (CVE 가 있으면 대표 ID 로 사용)
function toVulnerability(entry, allRelativeFiles) {
    const ids = [...entry.ids];
    const id = ids.find((value) => value.startsWith('CVE-')) ?? ids[0];

    return {
        id,
        aliases: ids.filter((value) => value !== id),
        package: entry.package,
        severity: entry.severity,
        cvssScore: entry.cvssScore,
        fixedVersions: [...entry.fixedVersions],
        title: entry.title ?? null,
        description: entry.description ?? null,
        cwes: [...entry.cwes],
        references: [...entry.references],
        publishedAt: entry.publishedAt ?? null,
        files: toRelativeFiles([...entry.files], allRelativeFiles),
        detectedBy: entry.detectedBy,
        sources: entry.sources
    };
}

// 인자로 받은 경로의 결과 파일만 읽어서 하나의 정형화된 형식으로 합침 (경로가 없거나 파일이 없으면 건너뜀)
// savePath 를 지정하면 정리된 결과를 해당 경로에 JSON 파일로 저장, target 은 점검 대상(URL 또는 경로)
export async function normalizeResult(osvPath, grypePath, trivyPath, savePath, target) {
    try {
        const tools = [
            { name: 'osv-scanner', path: osvPath, parse: parseOsv },
            { name: 'grype', path: grypePath, parse: parseGrype },
            { name: 'trivy', path: trivyPath, parse: parseTrivy }
        ];

        const findings = [];
        const inputs = {};
        let detectedTarget = target ?? null;

        for (const tool of tools) {
            const { data, skipped } = await readJson(tool.path);

            if (skipped) {
                inputs[tool.name] = { path: tool.path ?? null, used: false, reason: skipped };
                continue;
            }

            if (!detectedTarget) {
                detectedTarget = data?.ArtifactName ?? data?.source?.target?.userInput ?? null;
            }

            const parsed = tool.parse(data);
            findings.push(...parsed);
            inputs[tool.name] = { path: tool.path, used: true, findings: parsed.length };
        }

        if (!Object.values(inputs).some((input) => input.used)) {
            throw new Error('사용할 수 있는 결과 파일이 없습니다.');
        }

        const allRelativeFiles = unique(
            findings
                .flatMap((f) => f.files)
                .filter(Boolean)
                .map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''))
                .filter((file) => !/^(?:[A-Za-z]:\/|\/)/.test(file))
        );

        const vulnerabilities = mergeFindings(findings)
            .map((entry) => toVulnerability(entry, allRelativeFiles))
            .sort((a, b) =>
                SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity)
                || (b.cvssScore ?? 0) - (a.cvssScore ?? 0)
            );

        // Trivy/Grype 단독 탐지 등 설명이 짧거나 잘린 항목을 OSV API 로 보강 (실패해도 스캔은 정상 진행)
        await enrichWithOsv(vulnerabilities);

        const bySeverity = Object.fromEntries(SEVERITY_ORDER.slice().reverse().map((severity) => [severity, 0]));
        const byTool = {};
        vulnerabilities.forEach((vuln) => {
            bySeverity[vuln.severity]++;
            vuln.detectedBy.forEach((tool) => { byTool[tool] = (byTool[tool] ?? 0) + 1; });
        });

        const ecosystems = unique(vulnerabilities.map((vuln) => vuln.package.ecosystem));
        const scannedFiles = unique(vulnerabilities.flatMap((vuln) => vuln.files));
        const affectedPackages = new Set(
            vulnerabilities.map((vuln) => `${vuln.package.ecosystem}:${vuln.package.name}@${vuln.package.version}`)
        ).size;

        const normalized = {
            generatedAt: new Date().toISOString(),
            target: {
                source: detectedTarget,
                ecosystems,
                scannedFiles,
                affectedPackages
            },
            inputs,
            summary: {
                total: vulnerabilities.length,
                 affectedPackages,
                bySeverity,
                byTool,
                detectedByMultipleTools: vulnerabilities.filter((vuln) => vuln.detectedBy.length > 1).length
            },
            vulnerabilities
        };

        if (savePath) {
            const saveResult = await saveJson(normalized, savePath);
            if (!saveResult.result) {
                throw new Error(`파일 저장 실패: ${saveResult.data}`);
            }
        }

        return {
            result: true,
            data: normalized
        };
    }
    catch (error) {
        // 결과 정리 중 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}
