import { exec, execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// JSON 출력이 기본 버퍼(1MB)를 넘을 수 있으므로 크게 설정
const MAX_BUFFER = 1024 * 1024 * 100;
const DB_CMD_TIMEOUT_MS = 10 * 60 * 1000; // DB 다운로드/재구축 최대 10분
const SCANNER_BIN = process.platform === 'win32' ? 'grype.exe' : 'grype';
const SCANNER_PATH = path.join(__dirname, SCANNER_BIN);

const GRYPE_DB_ERROR_PATTERN =
    /(import\.json|import metadata|grype db delete|failed to load vulnerability db|database is invalid|vulnerability database|corrupt|no such table|max allowed age|database does not exist)/i;

// 병렬 스캔(MAX_CONCURRENT_JOBS) 중 DB 동시 덮어쓰기/잠금 충돌 방지용 Readers-Writer 락
let activeScans = 0;
let dbMaintenancePromise = null;
const drainResolvers = [];

function waitForActiveScansToDrain() {
    if (activeScans <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        drainResolvers.push(resolve);
    });
}

function notifyIfDrained() {
    if (activeScans > 0) return;
    while (drainResolvers.length > 0) {
        const resolve = drainResolvers.shift();
        resolve();
    }
}

function buildGrypeEnv(autoUpdate) {
    return {
        ...process.env,
        GRYPE_DB_AUTO_UPDATE: autoUpdate ? 'true' : 'false',
        GRYPE_CHECK_FOR_APP_UPDATE: 'false',
    };
}

async function runDbCommand(args) {
    return execFileAsync(SCANNER_PATH, args, {
        maxBuffer: MAX_BUFFER,
        timeout: DB_CMD_TIMEOUT_MS,
        env: buildGrypeEnv(false),
    });
}

/**
 * Grype 로컬 취약점 DB 상태를 직렬화(단독 실행)로 점검·갱신·자가 복구합니다.
 * - forceRebuild=true: 기존 손상 DB를 `db delete` 후 `db update`로 완전 재구축
 * - checkUpdate=true: 정상 상태라도 최신 DB 업데이트 확인 수행 (주기적 백그라운드 갱신용)
 */
export function ensureGrypeDb({ forceRebuild = false, checkUpdate = false, log = console.log } = {}) {
    if (dbMaintenancePromise) {
        return dbMaintenancePromise;
    }

    dbMaintenancePromise = (async () => {
        await waitForActiveScansToDrain();

        if (!forceRebuild) {
            let dbValid = false;
            try {
                await runDbCommand(['db', 'status']);
                dbValid = true;
            }
            catch {
                dbValid = false;
            }

            if (dbValid && !checkUpdate) {
                return { result: true, action: 'valid' };
            }

            if (dbValid && checkUpdate) {
                try {
                    log('[grype] 취약점 DB 최신 여부 확인 및 갱신 중...');
                    await runDbCommand(['db', 'update']);
                    log('[grype] 취약점 DB 최신 상태 확인 완료');
                    return { result: true, action: 'updated' };
                }
                catch (updateErr) {
                    const detail = String(updateErr?.stderr || updateErr?.message || '');
                    if (!GRYPE_DB_ERROR_PATTERN.test(detail)) {
                        // 일시적 네트워크 오류 등이고 기존 DB가 유효하면 스캔을 막지 않음
                        log(`[grype] 취약점 DB 주기 갱신 건너뜀 (기존 유효 DB 유지): ${detail.trim()}`);
                        return { result: true, action: 'kept-existing' };
                    }
                    // DB 메타데이터 손상이면 아래 재구축 단계로 진행
                }
            }
        }

        log('[grype] 취약점 DB 손상/만료 감지 -> db delete 후 재구축 시작...');
        await runDbCommand(['db', 'delete']).catch(() => {});
        await runDbCommand(['db', 'update']);
        log('[grype] 취약점 DB 재구축 완료');
        return { result: true, action: 'rebuilt' };
    })().finally(() => {
        dbMaintenancePromise = null;
    });

    return dbMaintenancePromise;
}

async function runSingleScan(targetPath) {
    while (dbMaintenancePromise) {
        await dbMaintenancePromise.catch(() => {});
    }

    activeScans += 1;
    try {
        // --fail-on low: 취약점이 발견되면 exit code 2로 종료
        // GRYPE_DB_AUTO_UPDATE=false: 병렬 스캔 중 DB 파일 동시 쓰기/잠금 충돌 원천 차단
        const command = `"${SCANNER_PATH}" "dir:${targetPath}" -o json --fail-on low`;
        await execAsync(command, {
            maxBuffer: MAX_BUFFER,
            env: buildGrypeEnv(false),
        });

        // 취약점이 없는 경우
        return {
            result: true,
            data: null,
        };
    }
    catch (error) {
        if (error.stdout) {
            // 취약점이 있는 경우, exit code 2로 종료되며 stdout에 JSON 출력
            try {
                return {
                    result: true,
                    data: JSON.parse(error.stdout),
                };
            }
            catch {
                // JSON이 아닌 출력이면 아래 실행 에러로 처리
            }
        }

        const detail = String(error?.stderr || error?.message || '').trim();
        return {
            result: false,
            data: error.message,
            isDbError: GRYPE_DB_ERROR_PATTERN.test(detail),
        };
    }
    finally {
        activeScans -= 1;
        notifyIfDrained();
    }
}

export async function grypeScanner(targetPath) {
    const first = await runSingleScan(targetPath);
    if (first.result || !first.isDbError) {
        return {
            result: first.result,
            data: first.data,
        };
    }

    // DB 손상/import.json 누락/만료 감지 시 직렬화 락으로 자동 복구 후 1회 재시도
    try {
        await ensureGrypeDb({ forceRebuild: true });
    }
    catch (repairError) {
        return {
            result: false,
            data: `Grype DB 자동 복구 실패: ${repairError?.message || String(repairError)}`,
        };
    }

    const retry = await runSingleScan(targetPath);
    return {
        result: retry.result,
        data: retry.data,
    };
}
