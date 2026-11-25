import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';

export async function downloadGithub(githubUrl, savePath) {
    const targetPath = path.resolve(savePath);
    const tempPath = `${targetPath}.tmp-${Date.now()}`;

    try {
        // https://github.com/{owner}/{repo} 형식만 허용
        const [, owner, repo] = githubUrl.trim().replace(/\.git$/, '').replace(/\/$/, '')
            .match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/) ?? [];
        if (!owner) {
            throw new Error('올바른 GitHub 저장소 URL이 아닙니다.');
        }

        // 저장 경로가 비어있지 않은 경우, 덮어쓰지 않고 에러 처리
        const existing = await fs.readdir(targetPath).catch(() => []);
        if (existing.length > 0) {
            throw new Error(`저장 경로가 비어있지 않습니다: ${targetPath}`);
        }

        // 기본 브랜치의 소스코드를 zip 으로 다운로드
        const response = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/HEAD`);
        if (!response.ok) {
            throw new Error(`다운로드 실패 (HTTP ${response.status})`);
        }
        const zipBuffer = Buffer.from(await response.arrayBuffer());

        // 임시 경로에 압축 해제 후, 최상위 폴더(repo-branch)를 벗겨내고 저장 경로로 이동
        new AdmZip(zipBuffer).extractAllTo(tempPath, true);
        const [rootFolder] = await fs.readdir(tempPath);

        await fs.rm(targetPath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rename(path.join(tempPath, rootFolder), targetPath);
        await fs.rm(tempPath, { recursive: true, force: true });

        return {
            result: true,
            data: targetPath
        };
    }
    catch (error) {
        // 다운로드 또는 압축 해제 에러인 경우
        await fs.rm(tempPath, { recursive: true, force: true });

        return {
            result: false,
            data: error.message
        };
    }
}
