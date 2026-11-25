import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// DynamoDB 테이블에서 특정 sandbox_uuid 행의 sandbox_status(및 선택적 completed_at) 값을 변경
export async function updateDynamo(sandboxUuid, status, options = {}) {
    try {
        if (sandboxUuid === undefined || sandboxUuid === null || String(sandboxUuid).trim() === '') {
            throw new Error('변경할 대상의 sandbox_uuid 값이 비어있습니다.');
        }

        if (status === undefined || status === null || String(status).trim() === '') {
            throw new Error('변경할 sandbox_status 값이 비어있습니다.');
        }

        const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
        const region = process.env.AWS_REGION?.trim();
        const tableName = process.env.DYNAMO_DB_TABLE_SANDBOX?.trim();

        if (!accessKeyId || !secretAccessKey || !region || !tableName) {
            throw new Error('AWS DynamoDB 환경변수(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, DYNAMO_DB_TABLE_SANDBOX)가 설정되지 않았습니다.');
        }

        const client = new DynamoDBClient({
            region,
            credentials: {
                accessKeyId,
                secretAccessKey
            }
        });
        const docClient = DynamoDBDocumentClient.from(client);

        let completedAt = null;
        if (options?.completedAt === true) {
            completedAt = Math.floor(Date.now() / 1000);
        } else if (typeof options?.completedAt === 'number' && Number.isFinite(options.completedAt) && options.completedAt > 0) {
            completedAt = Math.floor(options.completedAt);
        } else if (typeof options?.completedAt === 'string' && options.completedAt.trim() !== '') {
            const trimmed = options.completedAt.trim();
            const asNum = Number(trimmed);
            if (Number.isFinite(asNum) && asNum > 0) {
                completedAt = Math.floor(asNum);
            } else {
                const parsedMs = Date.parse(trimmed);
                if (!Number.isNaN(parsedMs)) {
                    completedAt = Math.floor(parsedMs / 1000);
                }
            }
        }

        const updateExpression = completedAt !== null
            ? 'SET sandbox_status = :status, completed_at = :completedAt'
            : 'SET sandbox_status = :status';

        const expressionAttributeValues = completedAt !== null
            ? {
                ':status': String(status),
                ':completedAt': completedAt
            }
            : {
                ':status': String(status)
            };

        const response = await docClient.send(new UpdateCommand({
            TableName: tableName,
            Key: {
                sandbox_uuid: String(sandboxUuid)
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        }));

        return {
            result: true,
            data: response.Attributes ?? null
        };
    }
    catch (error) {
        // DynamoDB 상태 변경 중 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}

