import fs from 'fs/promises';
import path from 'path';

export async function deletePath(targetPath) {
    try {
        if (typeof targetPath !== 'string' || !targetPath.trim()) {
            throw new Error('삭제할 경로가 비어있습니다.');
        }

        const resolvedPath = path.resolve(targetPath);

        // 드라이브 루트(C:\, D:\, /) 삭제 방지
        if (resolvedPath === path.parse(resolvedPath).root) {
            throw new Error(`루트 경로는 삭제할 수 없습니다: ${resolvedPath}`);
        }

        await fs.rm(resolvedPath, { recursive: true, force: true });

        return {
            result: true,
            data: null
        };
    }
    catch (error) {
        return {
            result: false,
            data: error.message
        };
    }
}

