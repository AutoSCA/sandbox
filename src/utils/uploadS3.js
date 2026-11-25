import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const CONTENT_TYPES = {
    '.pdf': 'application/pdf',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.zip': 'application/zip'
};

// 로컬 파일을 읽어서 AWS S3 버킷에 업로드 (s3Key 생략 시 원본 파일명 사용)
export async function uploadS3(filePath, s3Key) {
    try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
            throw new Error('업로드할 파일 경로가 비어있습니다.');
        }

        const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
        const region = process.env.AWS_REGION?.trim();
        const bucket = process.env.S3_BUCKET?.trim();

        if (!accessKeyId || !secretAccessKey || !region || !bucket) {
            throw new Error('AWS S3 환경변수(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET)가 설정되지 않았습니다.');
        }

        const resolvedPath = path.resolve(filePath);
        const stat = await fs.stat(resolvedPath).catch(() => null);
        if (!stat || !stat.isFile()) {
            throw new Error(`업로드할 파일을 찾을 수 없습니다: ${resolvedPath}`);
        }

        const fileBuffer = await fs.readFile(resolvedPath);
        const key = s3Key
            ? String(s3Key).replaceAll('\\', '/').replace(/^\/+/, '')
            : path.basename(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

        const s3Client = new S3Client({
            region,
            credentials: {
                accessKeyId,
                secretAccessKey
            }
        });

        await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileBuffer,
            ContentType: contentType
        }));

        const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;

        return {
            result: true,
            data: s3Url
        };
    }
    catch (error) {
        // S3 업로드 중 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}

