import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = util.promisify(exec);

// JSON 출력이 기본 버퍼(1MB)를 넘을 수 있으므로 크게 설정
const MAX_BUFFER = 1024 * 1024 * 100;

const SCANNER_BIN = process.platform === 'win32' ? 'trivy.exe' : 'trivy';

export async function trivyScanner(targetPath) {
    try {
        const scannerPath = path.join(__dirname, SCANNER_BIN);
        // --exit-code 1: 취약점이 발견되면 exit code 1로 종료
        // --offline-scan: 원격 패키지 저장소(Maven Central 등) API 조회 없이 로컬 파일 기반으로 스캔 (취약점 DB 업데이트는 유지)
        const command = `"${scannerPath}" fs --scanners vuln --format json --exit-code 1 --timeout 15m --quiet --offline-scan "${targetPath}"`;
        await execAsync(command, { maxBuffer: MAX_BUFFER });

        // 취약점이 없는 경우
        return {
            result: true,
            data: null
        };
    }
    catch (error) {
        if (error.stdout) {
            // 취약점이 있는 경우, exit code 1로 종료
            try {
                return {
                    result: true,
                    data: JSON.parse(error.stdout)
                };
            }
            catch {
                // JSON 이 아닌 출력이면 아래 실행 에러로 처리
            }
        }

        // trivy 실행 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}
