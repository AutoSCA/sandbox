import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// DynamoDB 단일 항목 최대 제한(400KB) 대비 안전 여유치
const MAX_GZIP_BYTES = 385 * 1024;

function gzipJson(obj) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 });
}

// 프론트엔드에서 표시하지 않는 HTML 주석·접힘(<details>)·이미지 태그만 먼저 제거해 무손실 압축 효율 향상
function cleanDescriptionBloat(desc) {
    if (typeof desc !== 'string') return desc;
    return desc
        .replace(/<details[\s\S]*?(?:<\/details>|$)/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<img[^>]*>/gi, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function truncateCleanly(desc, maxLen) {
    if (typeof desc !== 'string' || desc.length <= maxLen) return desc;
    const sliced = desc.slice(0, maxLen);
    const lastSpace = Math.max(sliced.lastIndexOf('\n'), sliced.lastIndexOf(' '));
    const cut = lastSpace > maxLen * 0.75 ? sliced.slice(0, lastSpace) : sliced;
    return `${cut.trimEnd()}...`;
}

// 보고서 JSON 을 항상 gzip 압축(Binary)하여 DynamoDB 400KB 제한에 맞게 준비
function compressReport(reportData) {
    let compressed = gzipJson(reportData);
    if (compressed.byteLength <= MAX_GZIP_BYTES) {
        return compressed;
    }

    // 1단계: 화면에 보이지 않는 HTML 군더더기 제거 및 참고 링크 5개 정리 (실질 설명 손실 없음)
    const cleaned = {
        ...reportData,
        vulnerabilities: (reportData?.vulnerabilities ?? []).map((v) => ({
            ...v,
            description: cleanDescriptionBloat(v.description),
            references: Array.isArray(v.references) ? v.references.slice(0, 5) : v.references
        }))
    };
    compressed = gzipJson(cleaned);
    if (compressed.byteLength <= MAX_GZIP_BYTES) {
        return compressed;
    }

    // 2단계: 초대용량 보고서(수백~천 건)일 때만 단계적으로 description 길이 완화 (급격한 300자 절단 방지)
    const tiers = [
        { maxDesc: 2400, maxRefs: 5 },
        { maxDesc: 1400, maxRefs: 5 },
        { maxDesc: 800, maxRefs: 5 },
        { maxDesc: 450, maxRefs: 4 },
        { maxDesc: 300, maxRefs: 3 }
    ];
    let latest = cleaned;
    for (const { maxDesc, maxRefs } of tiers) {
        latest = {
            ...cleaned,
            vulnerabilities: cleaned.vulnerabilities.map((v) => ({
                ...v,
                description: truncateCleanly(v.description, maxDesc),
                references: Array.isArray(v.references) ? v.references.slice(0, maxRefs) : v.references
            }))
        };
        compressed = gzipJson(latest);
        if (compressed.byteLength <= MAX_GZIP_BYTES) {
            return compressed;
        }
    }

    // 최후의 안전장치: description/references 제거 후 재압축
    const minimal = {
        ...latest,
        vulnerabilities: latest.vulnerabilities.map(({ description, references, ...rest }) => rest)
    };
    return gzipJson(minimal);
}

// 정규화된 JSON 보고서(객체 또는 파일 경로)를 gzip 압축해 DynamoDB gachon-p-project-sca-report 테이블에 저장
export async function putReportDynamo(sandboxUuid, reportOrFilePath, options = {}) {
    try {
        if (sandboxUuid === undefined || sandboxUuid === null || String(sandboxUuid).trim() === '') {
            throw new Error('저장할 대상의 sandbox_uuid 값이 비어있습니다.');
        }

        let reportData = reportOrFilePath;
        if (typeof reportOrFilePath === 'string') {
            const resolvedPath = path.resolve(reportOrFilePath);
            const rawText = await fs.readFile(resolvedPath, 'utf-8');
            reportData = JSON.parse(rawText);
        }

        if (!reportData || typeof reportData !== 'object') {
            throw new Error('DynamoDB 에 저장할 보고서 JSON 데이터가 올바르지 않습니다.');
        }

        const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
        const region = process.env.AWS_REGION?.trim();
        const tableName = process.env.DYNAMO_DB_TABLE_REPORT?.trim() || 'gachon-p-project-sca-report';

        if (!accessKeyId || !secretAccessKey || !region) {
            throw new Error('AWS DynamoDB 환경변수(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION)가 설정되지 않았습니다.');
        }

        const client = new DynamoDBClient({
            region,
            credentials: {
                accessKeyId,
                secretAccessKey
            }
        });
        const docClient = DynamoDBDocumentClient.from(client);

        const uuidStr = String(sandboxUuid).trim();
        const compressedReport = compressReport(reportData);
        const rawTtl = Number(options?.ttl);
        const item = {
            sandbox_uuid: uuidStr,
            report: compressedReport
        };
        if (Number.isInteger(rawTtl) && rawTtl > 0) {
            item.ttl = rawTtl;
        }

        await docClient.send(new PutCommand({
            TableName: tableName,
            Item: item
        }));

        return {
            result: true,
            data: `${tableName}/${uuidStr} (${(compressedReport.byteLength / 1024).toFixed(1)}KB gzip)`
        };
    }
    catch (error) {
        return {
            result: false,
            data: error.message
        };
    }
}
