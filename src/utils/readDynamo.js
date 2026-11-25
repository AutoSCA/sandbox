import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// DynamoDB 테이블에서 지정한 sandbox_status(기본값 0)인 행을 조회하여 반환 (all = true 이면 전체 배열 반환)
export async function readDynamo(status = 0, all = false) {
    try {
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

        // 문자열('0')과 숫자(0) 모두 매칭되도록 필터 설정
        const response = await docClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'sandbox_status = :statusStr OR sandbox_status = :statusNum',
            ExpressionAttributeValues: {
                ':statusStr': String(status),
                ':statusNum': Number(status)
            }
        }));

        const items = response.Items ?? [];

        return {
            result: true,
            data: all ? items : (items[0] ?? null)
        };
    }
    catch (error) {
        // DynamoDB 조회 중 에러인 경우
        return {
            result: false,
            data: error.message
        };
    }
}

