import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = util.promisify(exec);

// JSON 출력이 기본 버퍼(1MB)를 넘을 수 있으므로 크게 설정
const MAX_BUFFER = 1024 * 1024 * 100;

// osv-scanner 종료 코드
//   0   : 취약점 없음
//   1   : 취약점 발견 (stdout 에 JSON 결과)
//   128 : 의존성(패키지) 파일을 찾지 못함 -> 오류가 아니라 "검사 대상 없음"으로 보고 다음 단계 진행
const EXIT_NO_PACKAGES_FOUND = 128;

const SCANNER_BIN = process.platform === 'win32' ? 'osv-scanner.exe' : 'osv-scanner';

export async function osvScanner(targetPath) {
    try {
        const scannerPath = path.join(__dirname, SCANNER_BIN);
        const command = `"${scannerPath}" scan source --format json -r "${targetPath}"`;
        const { stdout } = await execAsync(command, { maxBuffer: MAX_BUFFER });

        // 취약점이 없는 경우
        return {
            result: true,
            data: null
        };
    }
    catch (error) {
        // 의존성 파일을 찾지 못한 경우: 취약점 없음과 동일하게 처리
        const noPackages =
            error.code === EXIT_NO_PACKAGES_FOUND ||
            /no package sources found/i.test(String(error.stderr ?? ''));
        if (noPackages) {
            return {
                result: true,
                data: null
            };
        }

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

        // osv-scanner 실행 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}