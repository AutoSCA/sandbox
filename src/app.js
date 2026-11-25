import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { downloadGithub } from './utils/downloadGithub.js';
import { osvScanner } from './scanner/osv-scanner/osvScanner.js';
import { grypeScanner } from './scanner/grype/grypeScanner.js';
import { trivyScanner } from './scanner/trivy/trivyScanner.js';
import { saveJson } from './utils/saveJson.js';
import { normalizeResult } from './utils/normalizeResult.js';
import { createPdf } from './utils/createPdf.js';
import { deletePath } from './utils/deletePath.js';
import { uploadS3 } from './utils/uploadS3.js';
import { updateDynamo } from './utils/updateDynamo.js';
import { putReportDynamo } from './utils/putReportDynamo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const BASE_DOWNLOAD_DIR = (process.env.DOWNLOAD_DIR || './downloads').replace(/\/+$/, '');
const BASE_RESULT_DIR = (process.env.RESULT_DIR || './results').replace(/\/+$/, '');
const ENABLE_LOG = String(process.env.ENABLE_LOG ?? 'true').toLowerCase() === 'true';

const log = (...args) => { if (ENABLE_LOG) console.log(...args); };
const logError = (...args) => { if (ENABLE_LOG) console.error(...args); };

// DynamoDB 진행 상태(sandbox_status) 및 선택적 종료 일시(completed_at) 변경 헬퍼
async function updateStatus(sandboxUuid, status, description, options = {}) {
    const res = await updateDynamo(sandboxUuid, status, options);
    if (res.result) {
        const suffix = options?.completedAt ? ` [completed_at: ${options.completedAt}]` : '';
        log(`[${sandboxUuid}] 상태 변경 완료 -> ${status} (${description})${suffix}`);
    } else {
        logError(`[${sandboxUuid}] 상태 변경 실패 (${status} - ${description}):`, res.data);
    }
}

// 개별 스캐너 실행 + JSON 결과 저장 (실패 시 예외 발생하여 해당 단계 * 10 상태로 전환)
async function runScanner(sandboxUuid, name, scanner, targetPath, savePath) {
    log(`[${sandboxUuid}] [${name}] 스캔 시작...`);
    const start = Date.now();
    const result = await scanner(targetPath);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (!result.result) {
        throw new Error(`[${name}] 스캔 실패 (${elapsed}s): ${result.data}`);
    }

    const saveResult = await saveJson(result.data, savePath);
    if (!saveResult.result) {
        throw new Error(`[${name}] 파일 저장 실패: ${saveResult.data}`);
    }

    log(`[${sandboxUuid}] [${name}] 스캔 및 저장 완료 (${elapsed}s)`);
}

// 단일 점검 대상(item)에 대한 전체 샌드박스 파이프라인 실행
export async function runSandbox(item) {
    const sandboxUuid = item?.sandbox_uuid;
    const githubUrl = item?.github_url;
    const rawTtl = Number(item?.ttl);
    const guestTtl = Number.isInteger(rawTtl) && rawTtl > 0 ? rawTtl : null;
    const isGuest = guestTtl !== null;

    if (!sandboxUuid || !githubUrl) {
        logError('[sandbox] 필수 정보(sandbox_uuid, github_url)가 누락되었습니다:', item);
        return { result: false, data: '필수 정보 누락' };
    }

    // 병렬 실행 시 서로 충돌하지 않도록 sandbox_uuid 별로 다운로드 및 결과 폴더 분리
    const downloadPath = `${BASE_DOWNLOAD_DIR}/${sandboxUuid}`;
    const resultDir = `${BASE_RESULT_DIR}/${sandboxUuid}`;
    const osvResultPath = `${resultDir}/result-osv.json`;
    const grypeResultPath = `${resultDir}/result-grype.json`;
    const trivyResultPath = `${resultDir}/result-trivy.json`;
    const normalizedResultPath = `${resultDir}/result-normalized.json`;
    const pdfReportPath = `${resultDir}/report.pdf`;

    let currentStatus = 0;

    try {
        log(`\n[${sandboxUuid}] 점검 시작: ${githubUrl}`);

        // 1. 소스 코드 다운로드 (status: 1, 실패 시: 10)
        currentStatus = 1;
        await updateStatus(sandboxUuid, currentStatus, '소스 코드 다운로드 시작');
        await deletePath(downloadPath);

        const downloadResult = await downloadGithub(githubUrl, downloadPath);
        if (!downloadResult.result) {
            throw new Error(`다운로드 실패: ${downloadResult.data}`);
        }
        const targetPath = downloadResult.data;

        // 2. 스캐너 3종 순차 실행 (status: 2 ~ 4, 실패 시: 20 ~ 40)
        currentStatus = 2;
        await updateStatus(sandboxUuid, currentStatus, 'osv-scanner 실행 시작');
        await runScanner(sandboxUuid, 'osv-scanner', osvScanner, targetPath, osvResultPath);

        currentStatus = 3;
        await updateStatus(sandboxUuid, currentStatus, 'grype 실행 시작');
        await runScanner(sandboxUuid, 'grype', grypeScanner, targetPath, grypeResultPath);

        currentStatus = 4;
        await updateStatus(sandboxUuid, currentStatus, 'trivy 스캔 시작');
        await runScanner(sandboxUuid, 'trivy', trivyScanner, targetPath, trivyResultPath);

        // 3. 스캔 결과 정규화 및 병합 (status: 5, 실패 시: 50)
        currentStatus = 5;
        await updateStatus(sandboxUuid, currentStatus, '스캔 결과 정리');
        const normalized = await normalizeResult(
            osvResultPath,
            grypeResultPath,
            trivyResultPath,
            normalizedResultPath,
            githubUrl
        );

        if (!normalized.result) {
            throw new Error(`결과 정리 실패: ${normalized.data}`);
        }

        // 4. 보고서 작성 (로그인: PDF 생성 + S3 업로드 + JSON DB 저장 / 비로그인: PDF·S3 생략 + TTL 포함 JSON DB 저장)
        currentStatus = 6;
        await updateStatus(sandboxUuid, currentStatus, '보고서 생성 시작');

        if (!isGuest) {
            const pdf = await createPdf(normalizedResultPath, pdfReportPath, githubUrl);
            if (!pdf.result) {
                throw new Error(`PDF 보고서 생성 실패: ${pdf.data}`);
            }
        } else {
            log(`[${sandboxUuid}] 비로그인(게스트) 요청이므로 PDF 생성 및 S3 업로드를 생략합니다.`);
        }

        // 5. 임시 소스코드 및 개별 스캐너 결과 JSON 삭제
        for (const target of [downloadPath, osvResultPath, grypeResultPath, trivyResultPath]) {
            await deletePath(target);
        }

        // 6. 로그인 회원은 PDF S3 업로드, 정규화 JSON 보고서는 DynamoDB(gachon-p-project-sca-report) 저장
        if (!isGuest) {
            const uploadResult = await uploadS3(pdfReportPath, `${sandboxUuid}/report.pdf`);
            if (!uploadResult.result) {
                throw new Error(`S3 업로드 실패 (${pdfReportPath}): ${uploadResult.data}`);
            }
            log(`[${sandboxUuid}] [s3] PDF 업로드 완료: ${uploadResult.data}`);
        }

        const reportSaveResult = await putReportDynamo(
            sandboxUuid,
            normalized.data,
            guestTtl ? { ttl: guestTtl } : {}
        );
        if (!reportSaveResult.result) {
            throw new Error(`DynamoDB 보고서 JSON 저장 실패: ${reportSaveResult.data}`);
        }
        log(`[${sandboxUuid}] [dynamodb] 보고서 JSON 저장 완료: ${reportSaveResult.data}`);

        // 7. 업로드 완료 상태 반영 (status: 7, completed_at 기록) 및 로컬 최종 파일/폴더 정리
        currentStatus = 7;
        await updateStatus(sandboxUuid, currentStatus, '보고서 저장 및 업로드 완료', {
            completedAt: Math.floor(Date.now() / 1000)
        });
        for (const target of [pdfReportPath, normalizedResultPath, resultDir]) {
            await deletePath(target);
        }

        log(`[${sandboxUuid}] 전체 점검 파이프라인 완료!`);
        return {
            result: true,
            data: sandboxUuid
        };
    }
    catch (error) {
        logError(`[${sandboxUuid}] 파이프라인 중단 (${currentStatus}단계):`, error.message);

        // 진행 중이던 단계에서 실패 시 기존 status * 10 으로 오류 상태 및 종료 일시 기록
        if (currentStatus > 0) {
            const errorStatus = currentStatus * 10;
            await updateStatus(sandboxUuid, errorStatus, `${currentStatus}단계 오류 발생`, {
                completedAt: Math.floor(Date.now() / 1000)
            });
        }

        // 에러 발생 시 남아있는 임시 폴더 정리
        await deletePath(downloadPath);
        await deletePath(resultDir);

        return {
            result: false,
            data: error.message
        };
    }
}
