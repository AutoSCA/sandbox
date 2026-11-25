import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = util.promisify(exec);

// JSON 출력이 기본 버퍼(1MB)를 넘을 수 있으므로 크게 설정
const MAX_BUFFER = 1024 * 1024 * 100;

const SCANNER_BIN = process.platform === 'win32' ? 'grype.exe' : 'grype';

export async function grypeScanner(targetPath) {
    try {
        const scannerPath = path.join(__dirname, SCANNER_BIN);
        // --fail-on low: 취약점이 발견되면 exit code 2로 종료
        const command = `"${scannerPath}" "dir:${targetPath}" -o json --fail-on low`;
        const { stdout } = await execAsync(command, { maxBuffer: MAX_BUFFER });

        // 취약점이 없는 경우
        return {
            result: true,
            data: null
        };
    }
    catch (error) {
        if (error.stdout) {
            // 취약점이 있는 경우, exit code 2로 종료
            return {
                result: true,
                data: JSON.parse(error.stdout)
            };
        }

        // grype 실행 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}
