import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force') || args.has('-f');
const DRY_RUN = args.has('--dry-run');

const IS_WIN = process.platform === 'win32';
const EXT = IS_WIN ? '.exe' : '';

function getArch() {
    if (process.arch === 'arm64') return 'arm64';
    if (process.arch === 'x64') return 'amd64';
    throw new Error(`지원하지 않는 CPU 아키텍처입니다: ${process.arch}`);
}

function getPlatformKey() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'darwin';
    if (process.platform === 'linux') return 'linux';
    throw new Error(`지원하지 않는 운영체제입니다: ${process.platform}`);
}

const SCANNERS = [
    {
        name: 'osv-scanner',
        repo: 'google/osv-scanner',
        destDir: path.join(ROOT_DIR, 'src', 'scanner', 'osv-scanner'),
        binaryName: `osv-scanner${EXT}`,
        matchAsset(assets, platform, arch) {
            const expected = `osv-scanner_${platform}_${arch}${platform === 'windows' ? '.exe' : ''}`;
            return assets.find((a) => a.name.toLowerCase() === expected.toLowerCase());
        },
        archiveType: 'raw',
    },
    {
        name: 'grype',
        repo: 'anchore/grype',
        destDir: path.join(ROOT_DIR, 'src', 'scanner', 'grype'),
        binaryName: `grype${EXT}`,
        matchAsset(assets, platform, arch) {
            const targetArch = platform === 'windows' ? 'amd64' : arch;
            const ext = platform === 'windows' ? '.zip' : '.tar.gz';
            const suffix = `_${platform}_${targetArch}${ext}`.toLowerCase();
            return assets.find(
                (a) => a.name.toLowerCase().startsWith('grype_') && a.name.toLowerCase().endsWith(suffix)
            );
        },
        archiveType: IS_WIN ? 'zip' : 'tar.gz',
    },
    {
        name: 'trivy',
        repo: 'aquasecurity/trivy',
        destDir: path.join(ROOT_DIR, 'src', 'scanner', 'trivy'),
        binaryName: `trivy${EXT}`,
        matchAsset(assets, platform, arch) {
            const osToken = platform === 'windows' ? 'windows' : platform === 'darwin' ? 'macOS' : 'Linux';
            const archToken = platform === 'windows' ? '64bit' : arch === 'arm64' ? 'ARM64' : '64bit';
            const ext = platform === 'windows' ? '.zip' : '.tar.gz';
            const suffix = `_${osToken}-${archToken}${ext}`.toLowerCase();
            return assets.find(
                (a) => a.name.toLowerCase().startsWith('trivy_') && a.name.toLowerCase().endsWith(suffix)
            );
        },
        archiveType: IS_WIN ? 'zip' : 'tar.gz',
    },
];

function buildGitHubHeaders() {
    const headers = {
        'User-Agent': 'AutoSCA-Sandbox-Installer',
        Accept: 'application/vnd.github+json',
    };
    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

async function fetchLatestRelease(repo) {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(url, { headers: buildGitHubHeaders() });
    if (!res.ok) {
        throw new Error(`GitHub 릴리스 조회 실패 (${repo}, HTTP ${res.status})`);
    }
    return res.json();
}

function formatMB(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadToFile(url, destPath, label) {
    const res = await fetch(url, { headers: { 'User-Agent': 'AutoSCA-Sandbox-Installer' }, redirect: 'follow' });
    if (!res.ok || !res.body) {
        throw new Error(`다운로드 실패 (${label}, HTTP ${res.status})`);
    }

    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    let lastReport = 0;

    const out = fs.createWriteStream(destPath);
    const reader = res.body.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (!out.write(value)) {
                await new Promise((resolve) => out.once('drain', resolve));
            }
            const now = Date.now();
            if (now - lastReport >= 350) {
                lastReport = now;
                const progress = total > 0
                    ? `${Math.min(100, Math.round((received / total) * 100))}% (${formatMB(received)} / ${formatMB(total)})`
                    : formatMB(received);
                process.stdout.write(`\r  [${label}] 다운로드 중... ${progress}   `);
            }
        }
        await new Promise((resolve, reject) => {
            out.on('finish', resolve);
            out.on('error', reject);
            out.end();
        });
        process.stdout.write(`\r  [${label}] 다운로드 완료 (${formatMB(received)})               \n`);
    }
    catch (err) {
        out.destroy();
        await fsp.rm(destPath, { force: true }).catch(() => {});
        throw err;
    }
}

async function extractFromZip(zipPath, binaryName, destPath) {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntries().find((e) => !e.isDirectory && path.basename(e.entryName) === binaryName);
    if (!entry) {
        throw new Error(`ZIP 압축 파일 안에서 ${binaryName}를 찾지 못했습니다.`);
    }
    await fsp.writeFile(destPath, entry.getData());
}

async function extractFromTarGz(tarPath, binaryName, destPath, tempDir) {
    const extractDir = path.join(tempDir, `extract-${Date.now()}`);
    await fsp.mkdir(extractDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', tarPath, '-C', extractDir]);

    const stack = [extractDir];
    let foundPath = null;
    while (stack.length > 0 && !foundPath) {
        const cur = stack.pop();
        const entries = await fsp.readdir(cur, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(cur, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name === binaryName) {
                foundPath = full;
                break;
            }
        }
    }

    if (!foundPath) {
        throw new Error(`tar.gz 압축 파일 안에서 ${binaryName}를 찾지 못했습니다.`);
    }
    await fsp.copyFile(foundPath, destPath);
}

async function installOne(scanner, platform, arch, tempDir) {
    const destPath = path.join(scanner.destDir, scanner.binaryName);

    if (!FORCE && fs.existsSync(destPath)) {
        const stat = await fsp.stat(destPath);
        if (stat.size > 0) {
            console.log(`[SKIP] ${scanner.name}: 이미 설치됨 (${path.relative(ROOT_DIR, destPath)}, ${formatMB(stat.size)})`);
            return;
        }
    }

    console.log(`[INFO] ${scanner.name}: 최신 릴리스 확인 중 (${scanner.repo})...`);
    const release = await fetchLatestRelease(scanner.repo);
    const asset = scanner.matchAsset(release.assets || [], platform, arch);
    if (!asset) {
        throw new Error(`${scanner.name} (${release.tag_name})에서 ${platform}/${arch}용 릴리스 파일을 찾지 못했습니다.`);
    }

    console.log(`  버전: ${release.tag_name} | 파일: ${asset.name} (${formatMB(asset.size || 0)})`);
    if (DRY_RUN) {
        console.log(`  [DRY-RUN] 다운로드 대상: ${asset.browser_download_url}`);
        console.log(`  [DRY-RUN] 설치 경로: ${path.relative(ROOT_DIR, destPath)}`);
        return;
    }

    await fsp.mkdir(scanner.destDir, { recursive: true });
    const tempFile = path.join(tempDir, asset.name);
    await downloadToFile(asset.browser_download_url, tempFile, scanner.name);

    const stagingPath = `${destPath}.tmp`;
    try {
        if (scanner.archiveType === 'raw') {
            await fsp.copyFile(tempFile, stagingPath);
        } else if (scanner.archiveType === 'zip') {
            await extractFromZip(tempFile, scanner.binaryName, stagingPath);
        } else {
            await extractFromTarGz(tempFile, scanner.binaryName, stagingPath, tempDir);
        }

        if (!IS_WIN) {
            await fsp.chmod(stagingPath, 0o755);
        }
        await fsp.rename(stagingPath, destPath);
        console.log(`[DONE] ${scanner.name} 설치 완료 → ${path.relative(ROOT_DIR, destPath)}`);
    }
    catch (err) {
        await fsp.rm(stagingPath, { force: true }).catch(() => {});
        throw err;
    }
}

async function main() {
    const platform = getPlatformKey();
    const arch = getArch();

    console.log('====================================================');
    console.log(` AutoSCA 스캐너 자동 설치 (${platform} / ${arch})${FORCE ? ' [강제 재설치]' : ''}${DRY_RUN ? ' [DRY-RUN]' : ''}`);
    console.log('====================================================');

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autosca-scanners-'));
    try {
        for (const scanner of SCANNERS) {
            await installOne(scanner, platform, arch, tempDir);
        }
        console.log('\n모든 스캐너 준비가 완료되었습니다.');
    }
    finally {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch((err) => {
    console.error(`\n[ERROR] 스캐너 설치 실패: ${err.message}`);
    process.exit(1);
});
