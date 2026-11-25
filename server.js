import dotenv from 'dotenv';
import { runSandbox } from './src/app.js';
import { readDynamo } from './src/utils/readDynamo.js';

dotenv.config({ quiet: true });

// DynamoDB 폴링 주기, 최대 동시 실행 작업 수, 로그 출력 여부 (.env 설정값)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 3;
const ENABLE_LOG = String(process.env.ENABLE_LOG ?? 'true').toLowerCase() === 'true';

const log = (...args) => { if (ENABLE_LOG) console.log(...args); };
const logError = (...args) => { if (ENABLE_LOG) console.error(...args); };

// 현재 실행 중인 작업(sandbox_uuid) 중복 실행 방지용 Set
const activeJobs = new Set();

async function pollPendingJobs() {
    try {
        // 이미 최대 동시 실행 개수만큼 돌고 있으면 다음 폴링 때 처리
        const availableSlots = MAX_CONCURRENT_JOBS - activeJobs.size;
        if (availableSlots <= 0) {
            return;
        }

        const dynamoResult = await readDynamo(0, true);
        if (!dynamoResult.result) {
            logError('[server] DynamoDB 조회 실패:', dynamoResult.data);
            return;
        }

        const pendingItems = (dynamoResult.data ?? [])
            .filter((item) => item?.sandbox_uuid && !activeJobs.has(item.sandbox_uuid))
            .slice(0, availableSlots);

        if (pendingItems.length === 0) {
            return;
        }

        log(`\n[server] 대기 작업 ${pendingItems.length}건 실행 시작 (현재 실행 중: ${activeJobs.size}/${MAX_CONCURRENT_JOBS})`);

        // 허용된 슬롯 범위 내에서 대기 작업(sandbox_status = 0)을 병렬로 시작
        for (const item of pendingItems) {
            const uuid = item.sandbox_uuid;
            activeJobs.add(uuid);

            runSandbox(item).finally(() => {
                activeJobs.delete(uuid);
            });
        }
    }
    catch (error) {
        logError('[server] 폴링 루프 에러:', error.message);
    }
}

log('====================================================');
log(' SCA Sandbox Worker Server 시작');
log(` DynamoDB 폴링 주기: ${POLL_INTERVAL_MS / 1000}초 | 최대 동시 작업 수: ${MAX_CONCURRENT_JOBS}건`);
log('====================================================');

// 서버 시작 시 즉시 1회 확인 후 주기적 폴링 실행
await pollPendingJobs();
setInterval(pollPendingJobs, POLL_INTERVAL_MS);
