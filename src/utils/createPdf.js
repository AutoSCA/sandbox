// pdfkit 기반 PDF 보고서 생성기
// - 기존 5섹션 보고서 항목·구성(1건/페이지 상세 포함) 100% 유지
// - AutoSCA Front-end(Cloudflare Kumo) 시그니처 디자인 전면 반영:
//   도트 웨이브 히어로, 3종 스캐너 벤 다이어그램, 심각도 도넛 차트, 언어 컬러 도트,
//   둥근 Kumo 테이블 프레임, 소프트 필 배지, 패키지 분포 막대, IDE 코드 카드, 구분|링크 참고자료 표
import PDFDocument from 'pdfkit';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* =========================================================================
   폰트 (서버 로컬 Noto Sans KR 고정 굵기 파일, 최초 1회 캐시)
   ========================================================================= */
const FONT_DIR = path.resolve(__dirname, '../fonts');
const FONT_FILES = {
    L: 'NotoSansKR-Light.ttf',
    R: 'NotoSansKR-Regular.ttf',
    M: 'NotoSansKR-Medium.ttf',
    B: 'NotoSansKR-Bold.ttf'
};
let fontCache = null;

async function loadFonts() {
    if (fontCache) return fontCache;
    const loaded = {};
    for (const [key, file] of Object.entries(FONT_FILES)) {
        loaded[key] = await fsp.readFile(path.join(FONT_DIR, file)).catch(() => null);
    }
    if (!loaded.R) throw new Error(`보고서 폰트를 찾을 수 없습니다: ${path.join(FONT_DIR, FONT_FILES.R)}`);
    loaded.L ??= loaded.R;
    loaded.M ??= loaded.R;
    loaded.B ??= loaded.M;
    fontCache = loaded;
    return fontCache;
}

/* =========================================================================
   AutoSCA Cloudflare Kumo 디자인 토큰 (Front-end tokens.css 1:1)
   ========================================================================= */
const s = (px) => px * 0.75; // CSS px -> PDF pt

const C = {
    // AutoSCA 포인트 블루
    primary: '#4e6dfd',       // --accent-blue
    link: '#3b5bf7',          // --kumo-link
    infoBg: '#f1f4ff',        // --kumo-info-bg
    infoBorder: '#d7e0ff',    // --kumo-info-border
    infoTitle: '#2f4ee0',     // --kumo-info-title

    // Kumo Dark 히어로 표면 (tokens.css dark theme)
    heroBg: '#0f0f0f',        // --kumo-canvas (dark)
    heroCard: '#171717',      // --kumo-base (dark)
    heroLine: '#2e2e2e',      // --kumo-line (dark)
    heroStrong: '#fafafa',    // --kumo-strong (dark)
    heroSubtle: '#a1a1a1',    // --kumo-subtle (dark)
    heroBlue: '#8fa6ff',      // --kumo-info-title (dark)

    // Kumo Light 표면 & 보더
    canvas: '#ffffff',        // --kumo-canvas
    surface: '#fafafa',       // --kumo-matrix-group-bg
    elevated: '#f5f5f5',      // --kumo-elevated
    recessed: '#f3f3f3',      // --kumo-recessed
    line: '#e5e5e5',          // --kumo-line
    hairline: '#efefef',      // --kumo-hairline
    badgeBorder: '#d4d4d4',   // --kumo-badge-border

    // Kumo Light 타이포그래피 잉크
    ink: '#0a0a0a',           // --kumo-strong
    inkBody: '#171717',       // --kumo-default
    inkNav: '#525252',        // --kumo-kbd-text
    inkMeta: '#737373',       // --kumo-subtle
    muted: '#a3a3a3'          // --kumo-placeholder
};

// A4, 좌우 여백 14mm (본문 폭 182mm), 상단 13mm / 하단 14mm
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MM = 72 / 25.4;
const MX = 14 * MM;
const CW = PAGE_W - MX * 2;
const TOP = 13 * MM;
const BOTTOM_MARGIN = 14 * MM;
const BOTTOM = PAGE_H - BOTTOM_MARGIN;

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

// Front-end tokens.css (Light & Dark) 심각도 팔레트
const SEVERITY_META = {
    CRITICAL: { label: 'CRITICAL', color: '#b92b24', dot: '#d93f38', bg: '#fbeceb', darkColor: '#f47067', darkBg: '#2e1a1a', darkBorder: '#5a2826' },
    HIGH: { label: 'HIGH', color: '#b8760b', dot: '#e39d24', bg: '#fbf2e3', darkColor: '#f6c96c', darkBg: '#2b2416', darkBorder: '#57431f' },
    MEDIUM: { label: 'MEDIUM', color: '#1e6fd9', dot: '#3b8ef3', bg: '#e8f1fe', darkColor: '#7cbcff', darkBg: '#172334', darkBorder: '#26446b' },
    LOW: { label: 'LOW', color: '#188a53', dot: '#26b26f', bg: '#e5f6ee', darkColor: '#6ce0a6', darkBg: '#162921', darkBorder: '#24523c' },
    UNKNOWN: { label: 'UNKNOWN', color: '#5c6470', dot: '#8c95a3', bg: '#eeeff2', darkColor: '#a1a8b3', darkBg: '#232528', darkBorder: '#3e4247' },
    SAFE: { label: 'SAFE', color: '#188a53', dot: '#26b26f', bg: '#e5f6ee', darkColor: '#6ce0a6', darkBg: '#162921', darkBorder: '#24523c' }
};

const VENN_SCANNERS = ['osv-scanner', 'grype', 'trivy'];
const TOOL_LABELS = {
    'osv-scanner': 'OSV-Scanner',
    'grype': 'Grype',
    'trivy': 'Trivy'
};
const TOOL_COLORS = {
    'osv-scanner': '#3b8ef3',
    'grype': '#7c5ce6',
    'trivy': '#14a89a'
};
const VENN_REGION_COLORS = {
    'osv-scanner': { fill: '#3b8ef3', opacity: 0.13 },
    'grype': { fill: '#7c5ce6', opacity: 0.13 },
    'trivy': { fill: '#14a89a', opacity: 0.13 },
    'osv-scanner+grype': { fill: '#5c70ee', opacity: 0.21 },
    'osv-scanner+trivy': { fill: '#2699c8', opacity: 0.21 },
    'grype+trivy': { fill: '#488bc4', opacity: 0.21 },
    'osv-scanner+grype+trivy': { fill: '#4e6dfd', opacity: 0.29 }
};

// Front-end constants/report.ts 언어별 컬러 매핑 (1:1 동기화)
const LANGUAGE_DEFS = [
    { key: 'javascript', label: 'JavaScript', color: '#e5b822', aliases: ['npm', 'yarn', 'pnpm', 'node-pkg', 'node', 'nodejs', 'javascript', 'js', 'typescript', 'ts', 'bun'] },
    { key: 'python', label: 'Python', color: '#3b82c4', aliases: ['pypi', 'python', 'pip', 'pipenv', 'poetry', 'uv', 'python-pkg', 'conda', 'py'] },
    { key: 'go', label: 'Go', color: '#00add8', aliases: ['go', 'golang', 'go-module', 'gomod', 'gobinary', 'go-binary'] },
    { key: 'java', label: 'Java', color: '#d97736', aliases: ['maven', 'java', 'java-archive', 'pom', 'gradle', 'jar', 'sbt', 'jenkins-plugin'] },
    { key: 'rust', label: 'Rust', color: '#d48d63', aliases: ['crates.io', 'rust-crate', 'cargo', 'rust'] },
    { key: 'ruby', label: 'Ruby', color: '#cc3d3d', aliases: ['rubygems', 'gem', 'gemspec', 'bundler', 'ruby'] },
    { key: 'php', label: 'PHP', color: '#7783c9', aliases: ['packagist', 'php-composer', 'composer', 'php'] },
    { key: 'dotnet', label: 'C# / .NET', color: '#5fa463', aliases: ['nuget', 'dotnet', 'dotnet-core', 'csharp', 'c#'] },
    { key: 'dart', label: 'Dart', color: '#00b4ab', aliases: ['pub', 'dart-pub', 'dart', 'flutter'] },
    { key: 'swift', label: 'Swift', color: '#f05138', aliases: ['swift', 'swifturl', 'cocoapods', 'carthage'] },
    { key: 'cpp', label: 'C / C++', color: '#659ad2', aliases: ['conan', 'cpp', 'c++', 'c', 'cmake', 'vcpkg'] },
    { key: 'elixir', label: 'Elixir', color: '#9b72cf', aliases: ['hex', 'mix', 'elixir', 'erlang-otp', 'erlang'] },
    { key: 'r', label: 'R', color: '#276dc3', aliases: ['cran', 'r'] },
    { key: 'haskell', label: 'Haskell', color: '#8f69c4', aliases: ['hackage', 'cabal', 'haskell'] },
    { key: 'kotlin', label: 'Kotlin', color: '#a97bff', aliases: ['kotlin', 'kt'] },
    { key: 'shell', label: 'Shell', color: '#7cc957', aliases: ['shell', 'bash', 'sh', 'zsh', 'powershell'] },
    { key: 'html', label: 'HTML', color: '#e34c26', aliases: ['html'] },
    { key: 'css', label: 'CSS', color: '#7c5ce6', aliases: ['css', 'scss', 'sass', 'less'] },
    { key: 'dockerfile', label: 'Docker', color: '#3899d6', aliases: ['dockerfile', 'docker'] },
    { key: 'actions', label: 'GitHub Actions', color: '#8c95a3', aliases: ['github actions', 'github-action', 'github-actions'] }
];
const LANG_ALIAS = new Map();
for (const def of LANGUAGE_DEFS) {
    for (const a of def.aliases) LANG_ALIAS.set(a, def);
}

const SOLUTION_NAME = 'AutoSCA · SCA 기반 취약 오픈소스 교차 점검 서비스';
const MAX_REFERENCES = 5;

// Front-end tokens.css (Light) GitHub Light IDE 신택스 하이라이팅 팔레트
const HL = {
    kw: '#cf222e',
    str: '#0a3069',
    num: '#0550ae',
    fn: '#8250df',
    type: '#953800',
    prop: '#0550ae',
    tag: '#116329',
    cmt: '#6e7781',
    meta: '#8250df',
    var: '#953800',
    punct: '#6e7781',
    add: '#116329',
    del: '#82071e'
};

// Front-end constants/cwe.ts 1:1 동기화 (한국어 CWE 명칭 및 MITRE 링크)
const CWE_KO_NAMES = {
    16: '보안 설정 오류', 20: '입력값 검증 미흡', 21: '경로 탐색 및 동등성 오류', 22: '경로 탐색',
    23: '상대 경로 탐색', 24: '상위 경로 탐색', 25: '상위 경로 탐색', 26: '중첩 경로 탐색',
    27: '상위 경로 탐색', 28: '역슬래시 경로 탐색', 29: '역슬래시 경로 탐색', 30: '역슬래시 경로 탐색',
    31: '역슬래시 경로 탐색', 32: '경로 탐색 (... 우회)', 33: '경로 탐색 (다중 점 우회)', 34: '경로 탐색 (중복 구분자 우회)',
    35: '경로 탐색 (중복 구분자 우회)', 36: '절대 경로 탐색', 37: '절대 경로 탐색', 38: '절대 경로 탐색',
    39: '드라이브 경로 탐색', 40: 'UNC 네트워크 경로 탐색', 41: '경로 동등성 해석 오류', 42: '경로 동등성 오류 (끝 점)',
    59: '심볼릭 링크 해석 오류', 61: '심볼릭 링크 추적', 62: '하드 링크 해석 오류', 64: '바로가기(.lnk) 링크 추적',
    65: 'Windows 하드 링크 오류', 73: '외부 파일명·경로 제어', 74: '인젝션', 75: '특수 문자 처리 미흡',
    77: '명령어 인젝션', 78: 'OS 명령어 인젝션', 79: '크로스 사이트 스크립팅 (XSS)', 80: '기본 XSS',
    83: '스크립트 속성 내 XSS', 84: '인코딩된 URI 스킴 XSS', 85: '이중 문자 XSS 필터 우회', 86: '식별자 내 무효 문자 XSS',
    87: '대체 XSS 구문 필터링 미흡', 88: '인자 인젝션', 89: 'SQL 인젝션', 90: 'LDAP 인젝션',
    91: 'XML 인젝션', 93: 'CRLF 인젝션', 94: '코드 인젝션', 95: '동적 코드 실행 (Eval 인젝션)',
    96: '정적 코드 인젝션', 97: 'SSI 인젝션', 98: '원격 파일 포함', 99: '리소스 인젝션',
    113: 'HTTP 응답 분할', 114: '프로세스 제어 오류', 116: '출력 인코딩 미흡', 117: '로그 인젝션',
    118: '인덱스 가능 리소스 범위 오류', 119: '메모리 버퍼 경계 오류', 120: '버퍼 오버플로우', 121: '스택 버퍼 오버플로우',
    122: '힙 버퍼 오버플로우', 123: '임의 메모리 쓰기', 124: '버퍼 언더라이트', 125: '범위 외 메모리 읽기',
    126: '버퍼 초과 읽기', 127: '버퍼 언더리드', 128: '정수 래핑 오류', 129: '배열 인덱스 검증 미흡',
    130: '길이 파라미터 불일치 처리 오류', 131: '버퍼 크기 계산 오류', 134: '포맷 스트링 취약점', 135: '멀티바이트 문자열 길이 계산 오류',
    138: '특수 문자 처리 미흡', 140: '구분자 처리 미흡', 141: '파라미터 구분자 처리 미흡', 142: '값 구분자 처리 미흡',
    144: '줄바꿈 구분자 처리 미흡', 146: '명령 구분자 처리 미흡', 147: '입력 종결자 처리 미흡', 148: '입력 접두 문자 처리 미흡',
    150: '이스케이프·제어 시퀀스 처리 미흡', 154: '변수명 구분자 처리 미흡', 155: '와일드카드 문자 처리 미흡', 158: '널 바이트 처리 미흡',
    159: '특수 요소 오용 처리 미흡', 160: '선행 특수 문자 처리 미흡', 162: '후행 특수 문자 처리 미흡', 164: '내부 특수 문자 처리 미흡',
    166: '특수 요소 누락 처리 미흡', 170: '널 종료 문자 누락', 172: '인코딩 오류', 173: '대체 인코딩 처리 미흡',
    174: '이중 디코딩 오류', 176: '유니코드 인코딩 처리 미흡', 178: '대소문자 처리 미흡', 179: '정규화 이전 조기 검증 오류',
    180: '정규화 이전 검증 오류', 181: '필터링 이전 검증 오류', 182: '필터링 후 안전하지 않은 값 생성', 183: '과도하게 넓은 허용 목록',
    184: '불완전한 차단 목록', 185: '정규표현식 오류', 187: '부분 문자열 비교 오류', 188: '메모리 레이아웃 의존 오류',
    189: '수치 연산 오류', 190: '정수 오버플로우', 191: '정수 언더플로우', 192: '정수 강제 변환 오류',
    193: '오프바이원 오류', 194: '예기치 않은 부호 확장', 195: '부호 있는 정수 변환 오류', 196: '부호 없는 정수 → 부호 있는 정수 변환 오류',
    197: '수치 절단 오류', 198: '바이트 순서(엔디안) 오류', 200: '민감 정보 노출', 201: '전송 데이터 내 민감 정보 포함',
    202: '데이터 쿼리를 통한 민감 정보 노출', 203: '응답 차이 정보 노출', 204: '응답 불일치 정보 노출', 208: '타이밍 공격 취약',
    209: '오류 메시지 정보 노출', 212: '민감 정보 제거 미흡', 213: '의도치 않은 민감 정보 노출', 214: '프로세스 환경 변수 정보 노출',
    215: '디버그 정보 노출', 219: '웹 루트 하위 민감 파일 저장', 220: 'FTP 루트 하위 민감 파일 저장', 221: '정보 손실·누락',
    222: '보안 정보 절단', 223: '보안 관련 정보 누락', 226: '재사용 전 민감 정보 미삭제', 228: '유효하지 않은 구문 구조 처리 미흡',
    229: '값 처리 미흡', 230: '누락된 값 처리 미흡', 231: '초과 값 처리 미흡', 232: '미정의 값 처리 미흡',
    233: '파라미터 처리 미흡', 234: '파라미터 누락 처리 오류', 235: '추가 파라미터 처리 미흡', 236: '미정의 파라미터 처리 미흡',
    237: '구조 요소 처리 미흡', 238: '불완전한 구조 요소 처리 미흡', 240: '일관성 없는 요소 처리 미흡', 241: '예상치 못한 데이터 타입 처리 미흡',
    242: '위험한 내장 함수 사용', 243: 'chroot 격리 설정 미흡', 244: '힙 메모리 잔류 민감 정보 노출', 248: '처리되지 않은 예외',
    250: '불필요한 권한 실행', 252: '반환값 미검사', 253: '함수 반환값 검사 오류', 254: '보안 기능 구현 오류',
    255: '자격 증명 관리 오류', 256: '비밀번호 평문 저장', 257: '복호화 가능한 비밀번호 저장', 258: '설정 파일 내 빈 비밀번호',
    259: '하드코딩된 비밀번호', 260: '설정 파일 내 비밀번호 노출', 261: '취약한 비밀번호 인코딩', 264: '권한·접근 제어 오류',
    266: '잘못된 권한 할당', 267: '안전하지 않은 권한 정의', 268: '권한 연쇄 상승', 269: '부적절한 권한 관리',
    270: '권한 컨텍스트 전환 오류', 271: '권한 하향 처리 오류', 272: '최소 권한 원칙 위반', 273: '권한 해제 확인 미흡',
    274: '불충분한 권한 제한', 275: '권한 설정 문제', 276: '안전하지 않은 기본 권한', 277: '안전하지 않은 권한 상속',
    278: '안전하지 않은 상속 권한 유지', 279: '실행 권한 설정 오류', 280: '권한 부족 상황 처리 미흡', 281: '권한 보존 미흡',
    282: '소유권 관리 미흡', 283: '소유권 미검증', 284: '접근 제어 미흡', 285: '부적절한 인가',
    286: '사용자 관리 미흡', 287: '부적절한 인증', 288: '대체 경로 인증 우회', 289: '대체 이름 기반 인증 우회',
    290: '스푸핑 인증 우회', 291: 'IP 주소 기반 인증 의존', 293: 'Referer 헤더 기반 인증 의존', 294: '인증 재전송 공격',
    295: '인증서 검증 미흡', 296: '인증서 신뢰 체인 검증 미흡', 297: '인증서 호스트명 불일치 검증 미흡', 298: '인증서 만료 검증 미흡',
    299: '인증서 폐기 여부 검증 미흡', 300: '중간자 공격 취약 채널', 302: '신뢰할 수 있는 값 변경을 통한 인증 우회', 303: '인증 알고리즘 구현 오류',
    304: '인증 필수 단계 누락', 305: '주요 약점을 통한 인증 우회', 306: '중요 기능 인증 누락', 307: '과도한 인증 시도 제한 미흡',
    308: '단일 요소 인증 사용', 310: '암호화 문제', 311: '민감 데이터 암호화 누락', 312: '민감 정보 평문 저장',
    313: '파일·디렉터리 평문 저장', 315: '쿠키 내 민감 정보 평문 저장', 316: '메모리 내 민감 정보 평문 저장', 319: '민감 정보 평문 전송',
    320: '암호화 키 관리 오류', 321: '하드코딩된 암호화 키', 322: '상대방 인증 없는 키 교환', 323: '암호화 논스(Nonce)·키 재사용',
    324: '만료된 키 사용', 325: '필수 암호화 단계 누락', 326: '취약한 암호화 강도', 327: '취약한 암호 알고리즘',
    328: '취약한 해시 사용', 329: 'CBC 모드 예측 가능한 IV 사용', 330: '난수성 부족', 331: '엔트로피 부족',
    332: '난수 생성기 엔트로피 부족', 333: '하드웨어 난수 엔트로피 부족 처리 미흡', 334: '작은 난수 공간', 335: 'PRNG 시드 값 미설정·오류',
    336: '동일한 PRNG 시드 재사용', 337: '예측 가능한 PRNG 시드', 338: '취약한 난수 생성기', 339: '작은 난수 시드 공간',
    340: '예측 가능한 숫자·식별자 생성', 341: '관측 가능한 상태 기반 값 예측', 342: '이전 값 기반 예측 가능', 343: '이전 값 기반 범위 예측 가능',
    344: '동적 환경 내 고정값 사용', 345: '데이터 진위성 검증 미흡', 346: '출처(Origin) 검증 오류', 347: '암호화 서명 검증 미흡',
    348: '신뢰할 수 없는 소스 사용', 349: '신뢰할 수 없는 데이터 수용', 350: '보안 결정에 역방향 DNS 의존', 351: '타입 구분 부족',
    352: '크로스 사이트 요청 위조 (CSRF)', 353: '무결성 검사 누락', 354: '데이터 무결성 검증 미흡', 357: '위험 작업 UI 경고 부족',
    358: '보안 검사 구현 미흡', 359: '개인정보 노출', 360: '시스템 이벤트 데이터 맹신', 362: '경쟁 조건 (Race Condition)',
    363: '링크 추적 경쟁 조건', 364: '시그널 핸들러 경쟁 조건', 365: '분기문 경쟁 조건', 366: '스레드 내 경쟁 조건',
    367: 'TOCTOU 경쟁 조건', 368: '컨텍스트 전환 경쟁 조건', 369: '0으로 나누기', 372: '불완전한 내부 상태 구분',
    374: '신뢰할 수 없는 메서드에 가변 객체 전달', 375: '신뢰할 수 없는 호출자에 가변 객체 반환', 377: '안전하지 않은 임시 파일', 378: '임시 파일 권한 설정 미흡',
    379: '안전하지 않은 디렉터리 내 임시 파일 생성', 382: '강제 프로세스 종료(System.exit) 호출', 384: '세션 고정', 385: '은밀한 타이밍 채널',
    388: '오류 처리 미흡', 390: '오류 감지 후 무조치', 391: '오류 조건 미검사', 392: '오류 조건 보고 누락',
    393: '잘못된 상태 코드 반환', 394: '예상치 못한 상태 코드·반환값', 395: '널 포인터 예외 포착 의존', 396: '광범위한 예외 포착',
    397: '포괄적 예외 선언', 399: '리소스 관리 오류', 400: '리소스 과다 소모 (DoS)', 401: '메모리 누수',
    402: '비공개 리소스 외부 누출', 403: '파일 디스크립터 외부 노출', 404: '리소스 해제 미흡', 405: '비대칭 리소스 소모',
    406: '네트워크 메시지 크기 제어 미흡', 407: '비효율적 알고리즘 복잡도', 408: '조기 증폭 응답 (DoS)', 409: '압축 해제 폭탄 (Zip Bomb)',
    410: '리소스 풀 부족', 412: '무제한 외부 잠금', 413: '부적절한 리소스 잠금', 414: '잠금 검사 누락',
    415: '이중 메모리 해제', 416: '해제 후 메모리 사용 (UAF)', 417: '통신 채널 오류', 419: '보호되지 않은 주 통신 채널',
    420: '보호되지 않은 대체 통신 채널', 421: '대체 채널 접근 경쟁 조건', 422: '보호되지 않은 Windows 메시지 채널', 424: '대체 경로 보호 미흡',
    425: '직접 요청 (강제 브라우징)', 426: '신뢰할 수 없는 검색 경로', 427: '제어되지 않는 검색 경로', 428: '따옴표 없는 검색 경로',
    430: '잘못된 핸들러 배치', 431: '핸들러 누락', 432: '민감 작업 중 시그널 핸들러 미비활성', 433: '미파싱 원본 웹 콘텐츠 전달',
    434: '위험한 파일 업로드', 435: '다중 개체 간 부적절한 상호작용', 436: '해석 불일치', 437: '불완전한 보안 모델 구현',
    440: '예상 동작 위반', 441: '의도치 않은 프록시·중개자 (Confused Deputy)', 444: 'HTTP 요청 밀수', 446: '보안 기능 UI 불일치',
    451: 'UI 위장 (클릭재킹)', 453: '안전하지 않은 변수 기본 초기화', 454: '외부 입력에 의한 신뢰 변수 초기화', 455: '초기화 실패 시 실행 계속',
    456: '변수 초기화 누락', 457: '초기화되지 않은 변수 사용', 459: '불완전한 정리 (Cleanup)', 460: '예외 발생 시 정리 누락',
    462: '연관 목록 내 중복 키', 463: '자료구조 종결자 삭제', 464: '자료구조 종결자 임의 삽입', 465: '포인터 오류',
    466: '예상 범위 외 포인터 반환', 467: '포인터 타입에 sizeof() 오용', 468: '잘못된 포인터 스케일링', 469: '포인터 뺄셈 크기 계산 오류',
    470: '외부 입력 기반 클래스·코드 로드 (리플렉션)', 471: '불변 데이터 수정 허용', 472: '클라이언트 측 민감 파라미터 의존', 474: '구현이 일관되지 않은 함수 사용',
    475: '미정의 동작 입력 처리', 476: '널 포인터 역참조', 477: '폐기된 함수 사용', 478: '조건문 기본(default) 분기 누락',
    479: '시그널 핸들러 내 비재진입 함수 호출', 480: '잘못된 연산자 사용', 481: '비교 대신 대입 연산자 오용', 482: '대입 대신 비교 연산자 오용',
    483: '잘못된 코드 블록 구분', 484: 'switch 문 break 누락', 489: '활성화된 디버그 코드', 494: '무결성 검증 없는 코드 다운로드',
    495: '공개 메서드에서 비공개 객체 반환', 496: '외부 데이터를 비공개 배열에 직접 할당', 497: '시스템 내부 정보 노출', 501: '신뢰 경계 위반',
    502: '안전하지 않은 역직렬화', 506: '악성 코드 삽입', 507: '트로이 목마', 508: '비복제 악성 코드',
    509: '복제 악성 코드 (바이러스·웜)', 510: '트랩도어 (백도어)', 511: '논리·시간 폭탄 악성 코드', 512: '스파이웨어',
    521: '취약한 비밀번호 정책', 522: '자격 증명 보호 미흡', 523: '자격 증명 보호 없는 전송', 524: '캐시를 통한 민감 정보 노출',
    525: '브라우저 캐시 민감 정보 저장', 526: '환경 변수를 통한 민감 정보 노출', 527: '버전 관리 저장소(.git 등) 외부 노출', 528: '코어 덤프 파일 외부 노출',
    529: '접근 제어 목록 파일 외부 노출', 530: '백업 파일 외부 노출', 531: '테스트 코드 내 민감 정보 포함', 532: '로그 내 민감 정보 기록',
    534: '디버그 로그 내 민감 정보 노출', 535: '셸 오류 메시지 정보 노출', 536: '런타임 오류 메시지 민감 정보 노출', 537: '런타임 예외 메시지 민감 정보 노출',
    538: '외부 노출 파일 내 민감 정보', 539: '영구 쿠키 내 민감 정보 저장', 540: '소스 코드 내 민감 정보 포함', 541: '포함 파일 내 민감 정보 노출',
    543: '멀티스레드 싱글톤 동기화 누락', 548: '디렉터리 리스팅 정보 노출', 549: '비밀번호 입력 마스킹 누락', 552: '외부 접근 가능 파일·디렉터리',
    553: '외부 접근 가능 경로 내 명령 셸', 560: 'umask 인자 오용', 564: 'SQL 인젝션 (Hibernate)', 565: '검증 없는 쿠키 의존',
    566: '사용자 제어 키를 통한 권한 우회', 567: '멀티스레드 공유 데이터 비동기 접근', 570: '항상 거짓인 조건식', 571: '항상 참인 조건식',
    573: '명세 준수 미흡', 587: '고정 메모리 주소 포인터 할당', 588: '비구조체 포인터 하위 접근', 590: '힙 외 메모리 해제',
    591: '잠금 미흡 메모리에 민감 정보 저장', 598: 'GET 쿼리 문자열 내 민감 정보 노출', 601: '오픈 리다이렉트', 602: '클라이언트 측 보안 검증 의존',
    603: '클라이언트 측 인증 의존', 605: '동일 포트 다중 바인딩', 606: '반복문 조건 입력값 미검증', 610: '외부 제어 리소스 참조',
    611: 'XML 외부 개체 참조 (XXE)', 613: '세션 만료 미흡', 614: '쿠키 Secure 속성 누락', 615: '주석 내 민감 정보 포함',
    616: '파일 식별 불완전', 617: '도달 가능한 단언 실패', 618: '안전하지 않은 ActiveX 컨트롤', 619: '해제되지 않은 DB 커서',
    620: '검증 없는 비밀번호 변경', 621: '외부 입력 변수 덮어쓰기', 622: '함수 후크 인자 검증 미흡', 623: '안전하지 않은 ActiveX 스크립팅 허용',
    624: '실행 가능한 정규표현식 오류', 625: '과도하게 허용된 정규표현식', 626: '널 바이트 처리 오류', 627: '동적 변수 평가 오류',
    628: '잘못된 인자 전달', 636: '안전하지 않은 실패 처리 (Fail Open)', 637: '보호 메커니즘 과도한 복잡성', 638: '접근 제어 완전 중재 누락',
    639: '권한 우회 (IDOR)', 640: '취약한 비밀번호 복구', 641: '파일·리소스 이름 제어 미흡', 642: '외부 상태 데이터 제어',
    643: 'XPath 인젝션', 644: 'HTTP 헤더 스크립팅 구문 처리 미흡', 645: '과도하게 제한적인 계정 잠금', 646: '외부 파일명·확장자 신뢰',
    647: '비정규 URL 경로 기반 권한 판별', 648: '특권 API 오용', 649: '무결성 검증 없는 난독화·암호화 의존', 650: 'HTTP 메서드 기반 권한 신뢰',
    652: 'XQuery 인젝션', 653: '리소스 격리 미흡', 656: '은닉에 의존한 보안', 657: '보안 설계 원칙 위반',
    662: '동기화 오류', 663: '동시성 환경 내 비재진입 함수 사용', 664: '리소스 생명주기 제어 미흡', 665: '부적절한 초기화',
    666: '잘못된 생명주기 단계 연산', 667: '부적절한 잠금 처리', 668: '리소스 범위 노출 오류', 669: '리소스 영역 간 잘못된 전달',
    670: '제어 흐름 구현 오류', 671: '관리자 제어 부족', 672: '만료된 리소스 사용', 673: '권한·영역 정의 외부 조작',
    674: '무한 재귀 호출', 675: '리소스 중복 연산', 676: '잠재적으로 위험한 함수 사용', 680: '정수 오버플로우로 인한 버퍼 오버플로우',
    681: '숫자 타입 변환 오류', 682: '잘못된 계산', 683: '함수 인자 순서 오류', 684: '명세와 불일치한 기능 구현',
    685: '함수 인자 개수 오류', 686: '함수 인자 타입 오류', 687: '잘못된 함수 인자값 전달', 688: '잘못된 변수·참조 인자 전달',
    689: '리소스 복사 중 권한 경쟁 조건', 690: '반환값 미검사로 인한 널 포인터 역참조', 691: '제어 흐름 관리 부족', 692: '불완전한 XSS 차단 목록',
    693: '보호 메커니즘 실패', 694: '중복 식별자 사용', 696: '잘못된 동작 실행 순서', 697: '잘못된 비교 연산',
    703: '예외 상황 검사·처리 미흡', 704: '잘못된 타입 변환', 705: '잘못된 제어 흐름 반환', 706: '잘못된 이름·참조 해석',
    707: '입력 중화(Neutralization) 미흡', 708: '잘못된 소유권 할당', 710: '보안 코딩 표준 위반', 732: '중요 리소스 권한 설정 오류',
    733: '컴파일러 최적화로 인한 보안 코드 제거', 749: '위험한 메서드·기능 노출', 754: '예외 조건 검사 미흡', 755: '예외 처리 미흡',
    756: '커스텀 오류 페이지 누락', 757: '안전하지 않은 알고리즘 협상 (다운그레이드)', 758: '미정의·구현 의존 동작 사용', 759: '솔트 없는 단방향 해시',
    760: '예측 가능한 솔트 해시', 761: '버퍼 시작점이 아닌 포인터 해제', 762: '메모리 할당·해제 함수 불일치', 763: '유효하지 않은 포인터·참조 해제',
    764: '중요 리소스 다중 잠금', 765: '중요 리소스 다중 잠금 해제', 768: '단락 평가(Short-Circuit) 오류', 769: '파일 디스크립터 고갈',
    770: '제한 없는 리소스 할당', 771: '활성 리소스 참조 누락', 772: '리소스 해제 누락', 773: '파일 디스크립터·핸들 참조 누락',
    774: '파일 디스크립터·핸들 할당 제한 미흡', 775: '파일 디스크립터·핸들 해제 누락', 776: 'XML 재귀 개체 확장', 777: '고정되지 않은 정규표현식',
    778: '로깅 부족', 779: '과도한 데이터 로깅', 780: 'OAEP 없는 RSA 알고리즘 사용', 781: 'IOCTL 주소 검증 미흡',
    782: '접근 제어 미흡 IOCTL 노출', 783: '연산자 우선순위 오류', 785: '출력 버퍼 크기 미지정 경로 조작', 786: '버퍼 시작 이전 메모리 접근',
    787: '범위 외 메모리 쓰기', 788: '버퍼 끝 이후 메모리 접근', 789: '과도한 크기의 메모리 할당', 790: '특수 요소 필터링 미흡',
    791: '특수 요소 불완전 필터링', 798: '하드코딩된 자격 증명', 799: '상호작용 빈도 제어 미흡', 804: '예측 가능한 CAPTCHA',
    805: '잘못된 길이 값 버퍼 접근', 806: '소스 버퍼 크기를 이용한 버퍼 접근', 807: '신뢰할 수 없는 입력 기반 보안 결정', 820: '동기화 누락',
    821: '잘못된 동기화', 822: '신뢰할 수 없는 포인터 역참조', 823: '범위 외 포인터 오프셋 사용', 824: '초기화되지 않은 포인터 접근',
    825: '만료된 포인터 역참조', 826: '리소스 조기 해제', 827: 'XML DTD 제어 미흡', 828: '비동기 비안전 시그널 핸들러',
    829: '신뢰할 수 없는 기능 포함', 830: '신뢰할 수 없는 도메인 웹 기능 포함', 831: '다중 시그널 공유 핸들러', 832: '잠기지 않은 리소스 해제',
    833: '교착 상태 (Deadlock)', 834: '과도한 반복 연산', 835: '무한 루프', 836: '인증 시 평문 비밀번호 사용',
    837: '단일 실행 제한 미흡', 838: '출력 컨텍스트 부적절한 인코딩', 839: '최솟값 검사 누락 범위 비교', 840: '비즈니스 로직 오류',
    841: '비즈니스 워크플로 강제 미흡', 842: '잘못된 그룹 내 배치', 843: '타입 혼동', 860: '파일 경로 해석 오류',
    862: '인가 검사 누락', 863: '부적절한 인가', 869: '리소스 참조 검증 미흡', 908: '초기화되지 않은 리소스 사용',
    909: '리소스 초기화 누락', 910: '만료된 파일 디스크립터 사용', 911: '참조 카운트 갱신 미흡', 912: '숨겨진 기능 (백도어)',
    913: '동적 코드 리소스 제어 미흡', 914: '동적 변수 평가 제어 미흡', 915: '동적 객체 속성 수정', 916: '취약한 비밀번호 해시',
    917: '표현식 언어 인젝션', 918: '서버 측 요청 위조 (SSRF)', 920: '전력·리소스 소비 제한 미흡', 921: '접근 제어 없는 민감 정보 저장',
    922: '민감 정보 안전하지 않은 저장', 923: '통신 채널 제한 미흡', 924: '전송 중 메시지 무결성 강제 미흡', 925: 'Android Broadcast Receiver 검증 미흡',
    926: 'Android 컴포넌트 부적절한 외부 노출', 927: '암시적 인텐트를 통한 민감 정보 전송', 939: '커스텀 URL 스킴 핸들러 인가 미흡', 940: '통신 채널 출처 검증 미흡',
    941: '잘못 지정된 통신 대상', 942: '과도한 CORS 허용', 943: '데이터 쿼리 로직 인젝션', 1004: '쿠키 HttpOnly 속성 누락',
    1007: '유사 문자(동형이의어) 시각적 구분 미흡', 1021: '화면 계층 제한 미흡 (클릭재킹)', 1022: 'window.opener 접근 허용 (Tabnabbing)', 1023: '조건 누락 불완전 비교',
    1024: '호환되지 않는 타입 간 비교', 1025: '값 대신 참조 비교 오류', 1035: '알려진 취약 컴포넌트 사용', 1049: '과도한 데이터 쿼리 연산',
    1050: '반복문 내 과도한 플랫폼 리소스 소비', 1068: '구현과 문서 간 불일치', 1088: '타임아웃 없는 동기식 원격 접근', 1104: '유지보수 중단된 외부 컴포넌트 사용',
    1125: '과도한 공격 표면', 1187: '초기화되지 않은 리소스 사용', 1188: '안전하지 않은 기본값 초기화', 1220: '접근 제어 세분화 부족',
    1236: 'CSV 수식 인젝션', 1254: '문자열 비교 로직 오류', 1255: '비교 로직 부채널 공격 취약', 1260: '중첩 메모리 영역 간 부적절한 처리',
    1275: '쿠키 SameSite 속성 설정 미흡', 1284: '입력 수량 검증 미흡', 1285: '입력 인덱스·위치·오프셋 검증 미흡', 1286: '입력 구문 유효성 검증 미흡',
    1287: '입력 타입 검증 미흡', 1288: '보안 관련 입력 일관성 검증 미흡', 1289: '비표준 데이터 표현 불안전 구현', 1295: '디버그 메시지 불필요한 정보 노출',
    1319: '프로토타입 체인 속성 접근 제어 미흡', 1321: '프로토타입 오염', 1322: '비차단 환경 내 블로킹 코드 사용', 1325: '과도한 요청 처리 시 리소스 제어 미흡',
    1326: '하드웨어 불변 신뢰 루트 누락', 1327: '제한 없는 IP 주소 바인딩', 1333: '정규표현식 서비스 거부 (ReDoS)', 1335: '잘못된 비트 연산',
    1336: '템플릿 인젝션 (SSTI)', 1357: '신뢰성 부족한 외부 컴포넌트 의존', 1384: '물리적·환경적 조건 처리 미흡', 1385: 'WebSocket 출처(Origin) 검증 누락',
    1386: 'Windows DLL/실행 경로 안전하지 않은 탐색', 1389: '진법이 다른 숫자 파싱 오류', 1390: '취약한 인증', 1391: '취약한 자격 증명 사용',
    1392: '기본 자격 증명 사용', 1393: '기본 비밀번호 사용', 1394: '기본 암호화 키 사용', 1395: '취약한 외부 의존성 사용',
    1419: '초기화 누락·불완전한 기본값', 1420: '투기적 실행 중 민감 정보 노출', 1426: '생성형 AI 출력 검증 미흡', 1427: 'LLM 프롬프트 인젝션',
    1428: 'HTTPS 대신 HTTP 의존', 1429: '민감 정보 입력 보안 피드백 누락'
};
const CWE_SPECIAL_KO_NAMES = {
    'NVD-CWE-noinfo': '유형 미분류',
    'NVD-CWE-Other': '기타 유형'
};

function formatCweDisplay(cwe) {
    const raw = String(cwe || '').trim();
    const specialKey = Object.keys(CWE_SPECIAL_KO_NAMES).find((k) => k.toLowerCase() === raw.toLowerCase());
    if (specialKey) {
        return { text: CWE_SPECIAL_KO_NAMES[specialKey], href: '' };
    }
    const numMatch = raw.match(/(\d+)/);
    if (!numMatch) return { text: raw, href: '' };
    const num = Number(numMatch[1]);
    return {
        text: CWE_KO_NAMES[num] || raw,
        href: `https://cwe.mitre.org/data/definitions/${num}.html`
    };
}

const st = (font, px, color, extra = {}) => ({ font, size: s(px), color, ...extra });

/* =========================================================================
   데이터 가공 헬퍼
   ========================================================================= */
function formatTargetName(targetSource) {
    if (!targetSource || targetSource === 'Local Source Directory' || targetSource === 'Local Workspace') {
        return '로컬 디렉터리 (Local Directory)';
    }
    const githubMatch = String(targetSource).match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
    if (githubMatch) return githubMatch[1];
    const normalized = String(targetSource).replaceAll('\\', '/').replace(/\/$/, '');
    return normalized.split('/').slice(-2).join('/') || normalized;
}

function extractGithubOwner(targetSource) {
    const match = String(targetSource ?? '').match(/github\.com\/([A-Za-z0-9-]+)\//i);
    return match ? match[1] : null;
}

function isSupportedImageBuffer(buf) {
    if (!buf || buf.length < 8) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return isPng || isJpeg;
}

async function fetchRepoAvatar(targetSource) {
    const owner = extractGithubOwner(targetSource);
    if (!owner) return null;
    try {
        const res = await fetch(`https://github.com/${encodeURIComponent(owner)}.png?size=160`, {
            redirect: 'follow',
            signal: AbortSignal.timeout(4000)
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return isSupportedImageBuffer(buf) ? buf : null;
    } catch {
        return null;
    }
}

function cleanFileList(files) {
    const normalized = (files ?? []).filter(Boolean).map((f) => String(f).replaceAll('\\', '/').replace(/^\.\//, ''));
    const relatives = normalized.filter((f) => !/^(?:[A-Za-z]:\/|\/)/.test(f));
    return [...new Set(normalized.map((file) => {
        if (!/^(?:[A-Za-z]:\/|\/)/.test(file)) return file;
        const matched = relatives.find((rel) => file.endsWith(`/${rel}`));
        return matched ?? file.split('/').pop();
    }))];
}

function resolveLanguage(rawEco) {
    const clean = String(rawEco ?? '').trim().toLowerCase();
    if (!clean) return { key: 'unknown', label: '기타', color: '#8c95a3' };
    const hit = LANG_ALIAS.get(clean) || LANG_ALIAS.get(clean.split(':')[0].trim());
    if (hit) return hit;
    return { key: clean, label: String(rawEco).toUpperCase(), color: '#8c95a3' };
}

function compareSemverDesc(a, b) {
    const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
    const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va === vb) continue;
        if (typeof va === 'number' && typeof vb === 'number') return vb - va;
        return String(vb).localeCompare(String(va));
    }
    return 0;
}

function pickRecommendedFixes(fixedVersions, installedVersion) {
    const uniqueFixes = [...new Set((fixedVersions ?? []).filter(Boolean))];
    if (uniqueFixes.length === 0) return [];

    const installedMajor = String(installedVersion ?? '').replace(/^v/i, '').split('.')[0];
    const sameMajor = uniqueFixes
        .filter((v) => String(v).replace(/^v/i, '').split('.')[0] === installedMajor)
        .sort(compareSemverDesc);
    if (sameMajor.length > 0) return [`${sameMajor[0]} 이상`];

    const byMajor = new Map();
    for (const v of uniqueFixes.sort(compareSemverDesc)) {
        const major = String(v).replace(/^v/i, '').split('.')[0];
        if (!byMajor.has(major)) byMajor.set(major, v);
    }
    return [...byMajor.values()].slice(0, 2).map((v) => `${v} 이상`);
}

function safeDecodePath(str) {
    try { return decodeURIComponent(str); } catch { return str; }
}

// Front-end utils/references.ts 와 동일한 8종 참고자료 분류 & GHSA 중복 제거
function parseReferenceMeta(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const segs = u.pathname.split('/').filter(Boolean);

        if (host === 'github.com') {
            if (segs[0] === 'advisories' && segs[1]) {
                return { source: '보안 권고', label: segs[1], dedupeKey: `ghsa:${segs[1].toUpperCase()}` };
            }
            if (segs.length >= 5 && segs[2] === 'security' && segs[3] === 'advisories') {
                return { source: '보안 권고', label: segs[4], dedupeKey: `ghsa:${segs[4].toUpperCase()}` };
            }
            if (segs.length >= 4 && segs[2] === 'commit') {
                return { source: '커밋', label: `${segs[0]}/${segs[1]} · ${segs[3].slice(0, 8)}` };
            }
            if (segs.length >= 5 && segs[2] === 'releases' && segs[3] === 'tag') {
                return { source: '릴리스', label: `${segs[0]}/${segs[1]} · ${safeDecodePath(segs[4])}` };
            }
            if (segs.length >= 3 && segs[2] === 'releases') {
                return { source: '릴리스', label: `${segs[0]}/${segs[1]}` };
            }
            if (segs.length >= 4 && segs[2] === 'pull') {
                return { source: 'PR', label: `${segs[0]}/${segs[1]} #${segs[3]}` };
            }
            if (segs.length >= 4 && segs[2] === 'issues') {
                return { source: '이슈', label: `${segs[0]}/${segs[1]} #${segs[3]}` };
            }
            if (segs.length >= 2) {
                return {
                    source: '저장소',
                    label: `${segs[0]}/${segs[1]}${segs.length > 2 ? `/${safeDecodePath(segs.slice(2).join('/'))}` : ''}`
                };
            }
        }
        if (host === 'nvd.nist.gov' && segs[0] === 'vuln' && segs[1] === 'detail' && segs[2]) {
            return { source: '취약점 DB', label: `NVD · ${segs[2]}` };
        }
        if (host === 'osv.dev' && segs[0] === 'vulnerability' && segs[1]) {
            return { source: '취약점 DB', label: `OSV · ${segs[1]}` };
        }
        if ((host === 'pkg.go.dev' && segs[0] === 'vuln' && segs[1]) || (host === 'vuln.go.dev' && segs[0])) {
            const goId = host === 'pkg.go.dev' ? segs[1] : segs[0];
            return { source: '취약점 DB', label: `Go · ${goId.replace(/\.json$/i, '')}` };
        }
        if (host === 'rustsec.org' && segs[0] === 'advisories' && segs[1]) {
            return { source: '보안 권고', label: segs[1].replace(/\.html$/i, '') };
        }
        if (host === 'cve.org' || host === 'cve.mitre.org') {
            const id = u.searchParams.get('id') || u.searchParams.get('name') || segs[segs.length - 1] || rawUrl;
            return { source: '취약점 DB', label: `CVE.org · ${id}` };
        }
        const pathLabel = segs.length ? `${host}/${safeDecodePath(segs.join('/'))}` : host;
        return { source: '외부 문서', label: pathLabel };
    } catch {
        return { source: '외부 문서', label: rawUrl };
    }
}

function dedupeAndParseReferences(references, maxCount = MAX_REFERENCES) {
    const seenUrls = new Set();
    const seenKeys = new Set();
    const parsed = [];
    for (const raw of references ?? []) {
        const url = String(raw || '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        const norm = url.replace(/\/+$/, '').toLowerCase();
        if (seenUrls.has(norm)) continue;
        seenUrls.add(norm);
        const meta = parseReferenceMeta(url);
        if (meta.dedupeKey) {
            if (seenKeys.has(meta.dedupeKey)) continue;
            seenKeys.add(meta.dedupeKey);
        }
        parsed.push({ url, ...meta });
        if (parsed.length >= maxCount) break;
    }
    return parsed;
}

/* =========================================================================
   도넛 & 3종 스캐너 벤 다이어그램 수학 기하 (Front-end utils/report.ts 1:1)
   ========================================================================= */
function buildDonutSlices(visibleSeverities, bySeverity, total) {
    const cx = 108;
    const cy = 108;
    const rOut = 92;
    const rIn = 70;
    const f = (n) => Number(n.toFixed(2));
    const pt = (r, deg) => {
        const rad = ((deg - 90) * Math.PI) / 180;
        return { x: f(cx + r * Math.cos(rad)), y: f(cy + r * Math.sin(rad)) };
    };

    if (visibleSeverities.length === 1) {
        return [{ sev: visibleSeverities[0], isFullRing: true }];
    }

    const gapDeg = 2.4;
    const minSliceDeg = 6;
    const rawAngles = visibleSeverities.map((sev) => ((bySeverity[sev] ?? 0) / total) * 360);
    const clamped = rawAngles.map((a) => Math.max(a, minSliceDeg));
    const normAngles = clamped.map((a) => (a / clamped.reduce((acc, v) => acc + v, 0)) * 360);

    let cursor = 0;
    return visibleSeverities.map((sev, idx) => {
        const span = normAngles[idx];
        const startDeg = cursor + gapDeg / 2;
        const endDeg = cursor + span - gapDeg / 2;
        cursor += span;

        const sweepDeg = Math.max(1, endDeg - startDeg);
        const largeArc = sweepDeg > 180 ? 1 : 0;
        const p1 = pt(rOut, startDeg);
        const p2 = pt(rOut, endDeg);
        const p3 = pt(rIn, endDeg);
        const p4 = pt(rIn, startDeg);
        const d = [
            `M ${p1.x} ${p1.y}`,
            `A ${rOut} ${rOut} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
            `L ${p3.x} ${p3.y}`,
            `A ${rIn} ${rIn} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
            'Z'
        ].join(' ');
        return { sev, isFullRing: false, d };
    });
}

function buildVennGeometry() {
    const cx = 108;
    const cy = 102;
    const R = 55;
    const d = 34;
    const sq3 = Math.sqrt(3);
    const f = (n) => Number(n.toFixed(2));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    const circles = [
        { id: 'osv-scanner', x: cx, y: cy - d, r: R },
        { id: 'grype', x: cx - (d * sq3) / 2, y: cy + d / 2, r: R },
        { id: 'trivy', x: cx + (d * sq3) / 2, y: cy + d / 2, r: R }
    ];

    const intersect = (i, j, k) => {
        const a = circles[i];
        const b = circles[j];
        const c = circles[k];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distAB = Math.hypot(dx, dy);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const h = Math.sqrt(R * R - (distAB / 2) * (distAB / 2));
        const ux = -dy / distAB;
        const uy = dx / distAB;
        const p1 = { x: mx + h * ux, y: my + h * uy };
        const p2 = { x: mx - h * ux, y: my - h * uy };
        return dist(p1, c) < dist(p2, c) ? { inner: p1, outer: p2 } : { inner: p2, outer: p1 };
    };

    const arcCmd = (center, from, to, largeArc) => {
        const a1 = Math.atan2(from.y - center.y, from.x - center.x);
        const a2 = Math.atan2(to.y - center.y, to.x - center.x);
        const cw = (((a2 - a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const sweep = largeArc ? (cw > Math.PI ? 1 : 0) : (cw < Math.PI ? 1 : 0);
        return `A ${R} ${R} 0 ${largeArc ? 1 : 0} ${sweep} ${f(to.x)} ${f(to.y)}`;
    };

    const makePath = (start, segs) =>
        `M ${f(start.x)} ${f(start.y)} ${segs.map(([ci, from, to, lg]) => arcCmd(circles[ci], from, to, lg)).join(' ')} Z`;

    const p01 = intersect(0, 1, 2);
    const p02 = intersect(0, 2, 1);
    const p12 = intersect(1, 2, 0);
    const rSolo = 56;
    const rPair = 39;

    const regions = [
        { key: 'osv-scanner', d: makePath(p01.outer, [[0, p01.outer, p02.outer, true], [2, p02.outer, p12.inner, false], [1, p12.inner, p01.outer, false]]), lx: f(cx), ly: f(cy - rSolo) },
        { key: 'grype', d: makePath(p12.outer, [[1, p12.outer, p01.outer, true], [0, p01.outer, p02.inner, false], [2, p02.inner, p12.outer, false]]), lx: f(cx - (rSolo * sq3) / 2), ly: f(cy + rSolo / 2) },
        { key: 'trivy', d: makePath(p02.outer, [[2, p02.outer, p12.outer, true], [1, p12.outer, p01.inner, false], [0, p01.inner, p02.outer, false]]), lx: f(cx + (rSolo * sq3) / 2), ly: f(cy + rSolo / 2) },
        { key: 'osv-scanner+grype', d: makePath(p01.outer, [[1, p01.outer, p12.inner, false], [2, p12.inner, p02.inner, false], [0, p02.inner, p01.outer, false]]), lx: f(cx - (rPair * sq3) / 2), ly: f(cy - rPair / 2) },
        { key: 'osv-scanner+trivy', d: makePath(p02.outer, [[0, p02.outer, p01.inner, false], [1, p01.inner, p12.inner, false], [2, p12.inner, p02.outer, false]]), lx: f(cx + (rPair * sq3) / 2), ly: f(cy - rPair / 2) },
        { key: 'grype+trivy', d: makePath(p12.outer, [[2, p12.outer, p02.inner, false], [0, p02.inner, p01.inner, false], [1, p01.inner, p12.outer, false]]), lx: f(cx), ly: f(cy + rPair) },
        { key: 'osv-scanner+grype+trivy', d: makePath(p12.inner, [[1, p12.inner, p01.inner, false], [0, p01.inner, p02.inner, false], [2, p02.inner, p12.inner, false]]), lx: f(cx), ly: f(cy), isCenter: true }
    ];

    return { vbX: 14, vbY: 6, vbW: 188, vbH: 176, circles, regions };
}

const VENN_GEO = buildVennGeometry();

function computeVennCounts(vulnerabilities) {
    const regions = Object.fromEntries(VENN_GEO.regions.map((r) => [r.key, 0]));
    const totals = { 'osv-scanner': 0, grype: 0, trivy: 0 };
    for (const v of vulnerabilities) {
        const list = Array.isArray(v.detectedBy) ? v.detectedBy : [];
        const key = VENN_SCANNERS.filter((sc) => list.includes(sc)).join('+');
        if (key && key in regions) regions[key] += 1;
        for (const sc of VENN_SCANNERS) {
            if (list.includes(sc)) totals[sc] += 1;
        }
    }
    return { regions, totals };
}

/* =========================================================================
   마크다운 파서 & GitHub Light 코드 신택스 하이라이터 (Front-end markdown.ts 1:1)
   ========================================================================= */
const CODE_LANG_META = {
    js: { mode: 'code', label: 'JavaScript' }, javascript: { mode: 'code', label: 'JavaScript' },
    mjs: { mode: 'code', label: 'JavaScript' }, cjs: { mode: 'code', label: 'JavaScript' },
    jsx: { mode: 'code', label: 'JSX' }, ts: { mode: 'code', label: 'TypeScript' },
    typescript: { mode: 'code', label: 'TypeScript' }, tsx: { mode: 'code', label: 'TSX' },
    json: { mode: 'json', label: 'JSON' }, jsonc: { mode: 'json', label: 'JSON' },
    sh: { mode: 'shell', label: 'Shell' }, bash: { mode: 'shell', label: 'Bash' },
    zsh: { mode: 'shell', label: 'Shell' }, shell: { mode: 'shell', label: 'Shell' },
    console: { mode: 'shell', label: 'Console' }, powershell: { mode: 'shell', label: 'PowerShell' },
    http: { mode: 'http', label: 'HTTP' }, diff: { mode: 'diff', label: 'Diff' },
    patch: { mode: 'diff', label: 'Diff' }, py: { mode: 'code', label: 'Python', hashComment: true },
    python: { mode: 'code', label: 'Python', hashComment: true }, rs: { mode: 'code', label: 'Rust' },
    rust: { mode: 'code', label: 'Rust' }, go: { mode: 'code', label: 'Go' },
    golang: { mode: 'code', label: 'Go' }, java: { mode: 'code', label: 'Java' },
    kt: { mode: 'code', label: 'Kotlin' }, kotlin: { mode: 'code', label: 'Kotlin' },
    c: { mode: 'code', label: 'C' }, cpp: { mode: 'code', label: 'C++' },
    cs: { mode: 'code', label: 'C#' }, csharp: { mode: 'code', label: 'C#' },
    rb: { mode: 'code', label: 'Ruby', hashComment: true }, ruby: { mode: 'code', label: 'Ruby', hashComment: true },
    php: { mode: 'code', label: 'PHP' }, sql: { mode: 'code', label: 'SQL' },
    yml: { mode: 'yaml', label: 'YAML' }, yaml: { mode: 'yaml', label: 'YAML' },
    toml: { mode: 'yaml', label: 'TOML' }, html: { mode: 'markup', label: 'HTML' },
    xml: { mode: 'markup', label: 'XML' }, svg: { mode: 'markup', label: 'SVG' }
};

function detectCodeLanguage(code, rawHint) {
    const hint = String(rawHint || '').trim().toLowerCase().split(/\s+/)[0];
    if (hint && CODE_LANG_META[hint]) return CODE_LANG_META[hint];
    const sample = code.trim();
    if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/[\d.]+/m.test(sample) || /^HTTP\/[\d.]+\s+\d{3}/m.test(sample)) {
        return { mode: 'http', label: 'HTTP' };
    }
    if (/^@@\s+-\d+/m.test(sample) || (/^\+\+\+\s/m.test(sample) && /^---\s/m.test(sample))) {
        return { mode: 'diff', label: 'Diff' };
    }
    if ((sample.startsWith('{') || sample.startsWith('[')) && /"[^"\n]+"\s*:/.test(sample)) {
        return { mode: 'json', label: 'JSON' };
    }
    if (/^<\/?[a-zA-Z][\w:-]*[\s>]/.test(sample)) {
        return { mode: 'markup', label: sample.startsWith('<?xml') ? 'XML' : 'HTML' };
    }
    if (/^\s*(?:\$\s+)?(?:npm|npx|yarn|pnpm|bun|cargo|pip|pip3|curl|git|go\s+get|go\s+mod|docker)\b/m.test(sample)) {
        return { mode: 'shell', label: 'Shell' };
    }
    if (/^\s*\[[\w.-]+\]\s*$/m.test(sample) && /^\s*[\w.-]+\s*=\s*/m.test(sample)) {
        return { mode: 'yaml', label: 'TOML' };
    }
    if (hint) return { mode: 'code', label: hint.toUpperCase() };
    return { mode: 'code', label: 'Code' };
}

function highlightCodeRuns(code, langInfo) {
    const mode = langInfo?.mode || 'code';
    const base = MD.pre;
    const tok = (color, text) => ({ ...base, color, text });

    const runWithPattern = (src, regex, onMatch) => {
        const runs = [];
        let last = 0;
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(src)) !== null) {
            if (m.index > last) runs.push({ ...base, text: src.slice(last, m.index) });
            const matched = onMatch(m);
            if (Array.isArray(matched)) runs.push(...matched);
            else if (matched) runs.push(matched);
            last = m.index + m[0].length;
            if (m[0].length === 0) regex.lastIndex += 1;
        }
        if (last < src.length) runs.push({ ...base, text: src.slice(last) });
        return runs;
    };

    if (mode === 'diff') {
        const runs = [];
        const lines = code.split('\n');
        lines.forEach((line, idx) => {
            const suffix = idx < lines.length - 1 ? '\n' : '';
            if (/^(?:\+\+\+|---)/.test(line)) runs.push(tok(HL.cmt, line + suffix));
            else if (/^@@/.test(line)) runs.push(tok(HL.meta, line + suffix));
            else if (line.startsWith('+')) runs.push(tok(HL.add, line + suffix));
            else if (line.startsWith('-')) runs.push(tok(HL.del, line + suffix));
            else runs.push({ ...base, text: line + suffix });
        });
        return runs;
    }

    if (mode === 'http') {
        const splitIdx = code.indexOf('\n\n');
        const headPart = splitIdx >= 0 ? code.slice(0, splitIdx) : code;
        const bodyPart = splitIdx >= 0 ? code.slice(splitIdx + 2) : '';
        const runs = [];
        const hLines = headPart.split('\n');
        hLines.forEach((line, idx) => {
            const req = line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)(\s+)(\S+)(\s+)(HTTP\/[\d.]+)$/);
            const res = !req && line.match(/^(HTTP\/[\d.]+)(\s+)(\d{3})(.*)$/);
            const hdr = !req && !res && line.match(/^([A-Za-z0-9-]+)(:)(\s*)(.*)$/);
            if (req) {
                runs.push(tok(HL.kw, req[1]), { ...base, text: req[2] }, tok(HL.str, req[3]), { ...base, text: req[4] }, tok(HL.num, req[5]));
            } else if (res) {
                runs.push(tok(HL.num, res[1]), { ...base, text: res[2] }, tok(HL.kw, res[3]), tok(HL.str, res[4]));
            } else if (hdr) {
                runs.push(tok(HL.prop, hdr[1]), tok(HL.punct, ':'), { ...base, text: hdr[3] }, tok(HL.str, hdr[4]));
            } else {
                runs.push({ ...base, text: line });
            }
            if (idx < hLines.length - 1) runs.push({ ...base, text: '\n' });
        });
        if (bodyPart) {
            runs.push({ ...base, text: '\n\n' }, ...highlightCodeRuns(bodyPart, detectCodeLanguage(bodyPart, '')));
        }
        return runs;
    }

    if (mode === 'json') {
        const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
        return runWithPattern(code, re, (m) => {
            if (m[1]) return tok(HL.cmt, m[1]);
            if (m[2]) return tok(HL.prop, m[2]);
            if (m[3]) return tok(HL.str, m[3]);
            if (m[4]) return tok(HL.kw, m[4]);
            return tok(HL.num, m[5]);
        });
    }

    if (mode === 'markup') {
        const re = /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z][\w:-]*)|(\/?>)|([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;
        return runWithPattern(code, re, (m) => {
            if (m[1]) return tok(HL.cmt, m[1]);
            if (m[2]) return [tok(HL.punct, m[2]), tok(HL.tag, m[3])];
            if (m[4]) return tok(HL.punct, m[4]);
            return [tok(HL.prop, m[5]), tok(HL.punct, m[6]), tok(HL.str, m[7])];
        });
    }

    if (mode === 'yaml') {
        const re = /(#[^\n]*)|^(\s*\[[^\]]+\])|^([ \t-]*)([\w.-]+)(\s*[:=])|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(true|false|null|yes|no)\b|\b(\d+(?:\.\d+)?)\b/gm;
        return runWithPattern(code, re, (m) => {
            if (m[1]) return tok(HL.cmt, m[1]);
            if (m[2]) return tok(HL.type, m[2]);
            if (m[4]) return [{ ...base, text: m[3] }, tok(HL.prop, m[4]), tok(HL.punct, m[5])];
            if (m[6]) return tok(HL.str, m[6]);
            if (m[7]) return tok(HL.kw, m[7]);
            return tok(HL.num, m[8]);
        });
    }

    if (mode === 'shell') {
        const re = /(#[^\n]*)|^(\s*[$>])(?=\s)|("(?:\\.|[^"\\])*"|'[^']*')|(\$\{?[A-Za-z_]\w*\}?)|(--?[a-zA-Z0-9][\w-]*)|\b(npm|npx|yarn|pnpm|bun|cargo|rustup|pip|pip3|python|python3|node|go|git|curl|wget|docker|kubectl|sudo|export|cd|ls|rm|cp|mv|chmod|echo|cat|grep|sed|awk|install|update|upgrade|add|run|build|test)\b|\b(if|then|else|fi|for|do|done|while|in|case|esac|function|return|exit)\b/gm;
        return runWithPattern(code, re, (m) => {
            if (m[1]) return tok(HL.cmt, m[1]);
            if (m[2]) return tok(HL.punct, m[2]);
            if (m[3]) return tok(HL.str, m[3]);
            if (m[4]) return tok(HL.var, m[4]);
            if (m[5]) return tok(HL.prop, m[5]);
            if (m[6]) return tok(HL.fn, m[6]);
            return tok(HL.kw, m[7]);
        });
    }

    const cmtPart = langInfo?.hashComment
        ? '(#[^\\n]*|\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)'
        : '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)';
    const re = new RegExp(
        `${cmtPart}|(\`(?:\\\\.|[^\`\\\\])*\`|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(@[a-zA-Z_]\\w*|\\b[a-zA-Z_]\\w*!)|\\b(async|await|break|case|catch|class|const|continue|crate|def|default|defer|delete|do|elif|else|enum|except|export|extends|extern|false|finally|fn|for|from|func|function|go|if|impl|import|in|instanceof|interface|is|lambda|let|loop|match|mod|mut|new|nil|None|not|null|of|or|package|pass|private|protected|pub|public|raise|range|ref|return|select|self|Self|static|struct|super|switch|this|throw|trait|true|True|False|try|type|typeof|undefined|unsafe|use|var|void|where|while|with|yield)\\b|\\b(0x[0-9a-fA-F_]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b|\\b([a-zA-Z_]\\w*)(?=\\s*\\()|\\b(u8|u16|u32|u64|usize|i32|i64|f64|bool|str|[A-Z][A-Za-z0-9_]*)\\b|(\\.)([a-zA-Z_]\\w*)`,
        'g'
    );
    return runWithPattern(code, re, (m) => {
        if (m[1]) return tok(HL.cmt, m[1]);
        if (m[2]) return tok(HL.str, m[2]);
        if (m[3]) return tok(HL.meta, m[3]);
        if (m[4]) return tok(HL.kw, m[4]);
        if (m[5]) return tok(HL.num, m[5]);
        if (m[6]) return tok(HL.fn, m[6]);
        if (m[7]) return tok(HL.type, m[7]);
        return [tok(HL.punct, m[8]), tok(HL.prop, m[9])];
    });
}

const MD = {
    p: st('R', 9.6, C.inkBody),
    bold: st('B', 9.6, C.ink),
    code: st('M', 8.8, C.ink, { bg: C.recessed, padX: s(3) }),
    link: st('R', 9.4, C.link),
    h: st('B', 10.2, C.ink),
    hCode: st('M', 9.2, C.ink, { bg: C.recessed, padX: s(3) }),
    pre: st('R', 8.8, C.inkBody),
    th: st('M', 8.8, C.inkNav),
    td: st('R', 9.2, C.inkBody),
    tdBold: st('B', 9.2, C.ink),
    tdCode: st('M', 8.6, C.ink, { bg: C.recessed, padX: s(2.5) })
};

function parseInline(text, base, bold = MD.bold, code = MD.code, link = MD.link) {
    const runs = [];
    const re = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
    const source = String(text ?? '');
    let last = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
        if (m.index > last) runs.push({ ...base, text: source.slice(last, m.index) });
        if (m[1] !== undefined) runs.push({ gap: code.padX ?? 0 }, { ...code, text: m[1] }, { gap: code.padX ?? 0 });
        else if (m[2] !== undefined) runs.push({ ...link, text: m[2].replace(/`/g, ''), link: m[3] });
        else if (m[4] !== undefined) runs.push({ ...bold, text: m[4] });
        last = re.lastIndex;
    }
    if (last < source.length) runs.push({ ...base, text: source.slice(last) });
    return runs;
}

function parseMarkdown(description, title = '') {
    const cleaned = String(description ?? '')
        .replace(/<details[\s\S]*?(?:<\/details>|$)/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<img[^>]*>/gi, '')
        .replace(/<\/?(?:details|summary|h\d|p|div|span|br|hr)[^>]*>/gi, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
    if (!cleaned) return [];

    const lines = cleaned.split('\n');
    const blocks = [];
    const normalizedTitle = String(title ?? '').replace(/[`*_#]/g, '').trim().toLowerCase();
    const isTableSep = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line ?? '');
    const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    let i = 0;

    while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (!trimmed || /^(?:---|\*\*\*|___)\s*$/.test(trimmed)) { i++; continue; }

        if (trimmed.startsWith('```')) {
            const fenceLang = trimmed.slice(3).trim();
            i++;
            const codeLines = [];
            while (i < lines.length && !lines[i].trim().startsWith('```')) codeLines.push(lines[i++]);
            if (i < lines.length) i++;
            let start = 0;
            let end = codeLines.length;
            while (start < end && !codeLines[start].trim()) start += 1;
            while (end > start && !codeLines[end - 1].trim()) end -= 1;
            const rawCode = codeLines.slice(start, end).join('\n');
            if (rawCode) {
                const langInfo = detectCodeLanguage(rawCode, fenceLang);
                blocks.push({ type: 'pre', lang: langInfo.label, runs: highlightCodeRuns(rawCode, langInfo) });
            }
            continue;
        }

        const heading = trimmed.match(/^#{1,6}\s+(.+)$/) || trimmed.match(/^\*\*(\d+\.\s+[^*]+)\*\*$/);
        if (heading) {
            const headingText = heading[1].replace(/\*\*/g, '').trim();
            const plain = headingText.replace(/[`*_]/g, '').trim().toLowerCase();
            i++;
            if (blocks.length === 0 && normalizedTitle && (plain === normalizedTitle || normalizedTitle.includes(plain) || plain.includes(normalizedTitle))) continue;
            blocks.push({ type: 'h', runs: parseInline(headingText, MD.h, MD.h, MD.hCode, { ...MD.link, size: MD.h.size }) });
            continue;
        }

        if (trimmed.startsWith('|') && isTableSep(lines[i + 1])) {
            const headers = splitRow(trimmed);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].trim().startsWith('|')) {
                if (!isTableSep(lines[i])) rows.push(splitRow(lines[i]));
                i++;
            }
            blocks.push({
                type: 'table',
                headers: headers.map((h) => parseInline(h, MD.th, MD.th, MD.tdCode)),
                rows: rows.map((r) => headers.map((_, c) => parseInline(r[c] ?? '', MD.td, MD.tdBold, MD.tdCode)))
            });
            continue;
        }

        const listMatch = trimmed.match(/^([-*]|\d+\.)\s+/);
        if (listMatch) {
            const ordered = /\d/.test(listMatch[1]);
            const re = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
            const items = [];
            while (i < lines.length && re.test(lines[i].trim())) {
                items.push(parseInline(lines[i].trim().replace(re, ''), MD.p));
                i++;
            }
            blocks.push({ type: 'list', ordered, items });
            continue;
        }

        const para = [];
        while (
            i < lines.length &&
            lines[i].trim() &&
            !/^(?:---|\*\*\*|___)\s*$/.test(lines[i].trim()) &&
            !lines[i].trim().startsWith('```') &&
            !/^#{1,6}\s+/.test(lines[i].trim()) &&
            !/^\*\*(\d+\.\s+[^*]+)\*\*$/.test(lines[i].trim()) &&
            !(lines[i].trim().startsWith('|') && isTableSep(lines[i + 1])) &&
            !/^[-*]\s+/.test(lines[i].trim()) &&
            !/^\d+\.\s+/.test(lines[i].trim())
        ) {
            para.push(lines[i].trim().replace(/^>\s?/, ''));
            i++;
        }
        if (para.length > 0) blocks.push({ type: 'p', runs: parseInline(para.join(' '), MD.p) });
    }

    return blocks;
}

/* =========================================================================
   Kumo 벡터 렌더러 (둥근 프레임 표 · 도넛 · 벤 · 도트 웨이브 · 플랫 필 배지)
   ========================================================================= */
class Renderer {
    constructor(doc) {
        this.doc = doc;
        this.y = 0;
        this.metrics = {};
        this.widthCache = new Map();
    }

    rect(x, y, w, h, color) {
        this.doc.save().rect(x, y, w, h).fill(color).restore();
    }

    roundedBox(x, y, w, h, radius, { fill = null, stroke = null, lineWidth = s(1) } = {}) {
        const d = this.doc.save();
        if (fill && stroke) {
            d.lineWidth(lineWidth).roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke);
        } else if (fill) {
            d.roundedRect(x, y, w, h, radius).fill(fill);
        } else if (stroke) {
            d.lineWidth(lineWidth).roundedRect(x, y, w, h, radius).stroke(stroke);
        }
        d.restore();
    }

    dot(cx, cy, r, color) {
        this.doc.save().circle(cx, cy, r).fill(color).restore();
    }

    hline(x1, x2, y, color = C.hairline, width = s(0.85)) {
        this.doc.save().rect(x1, y, x2 - x1, width).fill(color).restore();
    }

    vline(x, y1, y2, color = C.hairline, width = s(0.85)) {
        this.doc.save().rect(x, y1, width, y2 - y1).fill(color).restore();
    }

    newPage() {
        this.doc.addPage({ size: 'A4', margin: 0 });
        this.y = TOP;
    }

    ensure(height) {
        if (this.y + height > BOTTOM && this.y > TOP + 0.5) this.newPage();
    }

    fontMetrics(font) {
        if (!this.metrics[font]) {
            this.doc.font(font);
            const f = this.doc._font;
            this.metrics[font] = { asc: f.ascender / 1000, desc: f.descender / 1000 };
        }
        return this.metrics[font];
    }

    width(text, style) {
        const key = `${style.font}|${style.size}|${text}`;
        let w = this.widthCache.get(key);
        if (w === undefined) {
            if (this.widthCache.size > 25000) this.widthCache.clear();
            w = this.doc.font(style.font).fontSize(style.size).widthOfString(text);
            this.widthCache.set(key, w);
        }
        return w;
    }

    layout(runs, maxW, { lh = 1.45, wrap = 'normal' } = {}) {
        const lines = [];
        let cur = { items: [], w: 0 };
        let pendingSpace = null;

        const push = (text, style) => {
            const w = this.width(text, style);
            const last = cur.items[cur.items.length - 1];
            if (last && last.style === style && !last.isDot && !last.isGap) {
                last.text += text;
                last.w += w;
            } else {
                cur.items.push({ text, style, w });
            }
            cur.w += w;
        };
        const breakLine = () => {
            lines.push(cur);
            cur = { items: [], w: 0 };
            pendingSpace = null;
        };
        const placeChars = (token, style) => {
            for (const ch of Array.from(token)) {
                const cw = this.width(ch, style);
                if (cur.items.length && cur.w + cw > maxW + 0.01) breakLine();
                push(ch, style);
            }
        };
        const place = (token, style) => {
            const sp = pendingSpace ? this.width(' ', pendingSpace) : 0;
            const tw = this.width(token, style);
            if (wrap === 'none' || cur.w + sp + tw <= maxW + 0.01) {
                if (pendingSpace) push(' ', pendingSpace);
                pendingSpace = null;
                push(token, style);
                return;
            }
            if (wrap === 'normal' && tw <= maxW) {
                breakLine();
                push(token, style);
                return;
            }
            if (wrap === 'normal' && cur.items.length) breakLine();
            if (pendingSpace && cur.w + sp < maxW) push(' ', pendingSpace);
            pendingSpace = null;
            placeChars(token, style);
        };

        for (let rIdx = 0; rIdx < runs.length; rIdx++) {
            const run = runs[rIdx];
            if (!run) continue;
            if (run.gap) {
                const sp = pendingSpace ? this.width(' ', pendingSpace) : 0;
                if (cur.items.length && cur.w + sp + run.gap > maxW + 0.01 && wrap !== 'none') breakLine();
                if (pendingSpace) push(' ', pendingSpace);
                pendingSpace = null;
                if (cur.items.length) {
                    cur.items.push({ isGap: true, text: '', style: run, w: run.gap });
                    cur.w += run.gap;
                }
                continue;
            }
            if (run.dot) {
                const rDot = run.r ?? s(2.8);
                const wDot = rDot * 2 + s(4.5);
                const nextRun = runs[rIdx + 1];
                const nextFirstTok = nextRun?.text ? String(nextRun.text).trim().split(/\s+/)[0] : '';
                const nextW = nextFirstTok ? this.width(nextFirstTok, nextRun) : 0;
                const sp = pendingSpace ? this.width(' ', pendingSpace) : 0;
                if (cur.items.length && cur.w + sp + wDot + nextW > maxW + 0.01 && wrap !== 'none') breakLine();
                if (pendingSpace) push(' ', pendingSpace);
                pendingSpace = null;
                cur.items.push({ isDot: true, dotColor: run.dot, rDot, text: '', style: { size: run.size ?? s(9.5) }, w: wDot });
                cur.w += wDot;
                continue;
            }
            let text = String(run.text ?? '');
            if (!text) continue;
            if (wrap !== 'pre') text = text.replace(/\s+/g, ' ');
            const segments = wrap === 'pre' ? text.split('\n') : [text];

            segments.forEach((seg, si) => {
                if (si > 0) breakLine();
                for (const token of seg.match(/\s+|\S+/g) ?? []) {
                    if (wrap !== 'pre' && /^\s+$/.test(token)) {
                        if (cur.items.length) pendingSpace = run;
                        continue;
                    }
                    place(token, run);
                }
            });
        }
        if (cur.items.length || lines.length === 0) lines.push(cur);

        const baseSize = runs.find((run) => run?.size)?.size ?? s(9.5);
        let height = 0;
        let width = 0;
        for (const line of lines) {
            while (line.items.length && line.items[line.items.length - 1].isGap) {
                line.w -= line.items.pop().w;
            }
            const maxSize = line.items.reduce((m, it) => Math.max(m, it.style?.size ?? 0), 0) || baseSize;
            line.h = maxSize * lh;
            height += line.h;
            width = Math.max(width, line.w);
        }
        return { lines, height, width };
    }

    drawLines(laid, x, y, w, { align = 'left', paginate = false } = {}) {
        const doc = this.doc;
        for (const line of laid.lines) {
            if (paginate && y + line.h > BOTTOM && y > TOP + 0.5) {
                this.newPage();
                y = this.y;
            }
            if (line.items.length) {
                const textItems = line.items.filter((it) => !it.isGap && !it.isDot);
                const big = (textItems.length ? textItems : line.items)
                    .reduce((a, b) => ((b.style?.size ?? 0) > (a.style?.size ?? 0) ? b : a));
                const bm = this.fontMetrics(big.style?.font ?? 'R');
                const contentH = (bm.asc - bm.desc) * (big.style?.size ?? s(9.5));
                const baseline = y + (line.h - contentH) / 2 + bm.asc * (big.style?.size ?? s(9.5));

                let cx = x;
                if (align === 'right') cx = x + w - line.w;
                else if (align === 'center') cx = x + (w - line.w) / 2;

                for (const item of line.items) {
                    if (item.isGap) { cx += item.w; continue; }
                    if (item.isDot) {
                        this.dot(cx + item.rDot, y + line.h / 2 + 0.3, item.rDot, item.dotColor);
                        cx += item.w;
                        continue;
                    }
                    const m = this.fontMetrics(item.style.font);
                    const top = baseline - m.asc * item.style.size;
                    if (item.style.bg) {
                        const bh = (m.asc - m.desc) * item.style.size;
                        const padX = item.style.padX ?? 1.5;
                        doc.save()
                            .roundedRect(cx - padX, top - 0.3, item.w + padX * 2, bh + 0.6, s(2))
                            .fill(item.style.bg)
                            .restore();
                    }
                    doc.font(item.style.font)
                        .fontSize(item.style.size)
                        .fillColor(item.style.color, item.style.opacity ?? 1)
                        .text(item.text, cx, top, { lineBreak: false });
                    if (item.style.opacity != null) doc.fillOpacity(1);
                    if (item.style.link) doc.link(cx, y, item.w, line.h, item.style.link);
                    cx += item.w;
                }
            }
            y += line.h;
        }
        return y;
    }

    text(runs, x, y, w, opts = {}) {
        const laid = this.layout(Array.isArray(runs) ? runs : [runs], w, opts);
        return this.drawLines(laid, x, y, w, opts);
    }

    measure(runs, w, opts = {}) {
        return this.layout(Array.isArray(runs) ? runs : [runs], w, opts).height;
    }

    /* ---------- 보고서용 직각 심각도 태그 배지 ---------- */
    badgeSize(label, px = 8.4) {
        const style = st('B', px, C.ink);
        return { w: this.width(label, style) + s(12), h: style.size * 1.15 + s(6), style };
    }

    badge(severity, x, y, { px = 8.4, dark = false } = {}) {
        const meta = SEVERITY_META[severity] ?? SEVERITY_META.UNKNOWN;
        return this.labelBadge(meta.label, meta, x, y, { px, dark });
    }

    labelBadge(label, meta, x, y, { px = 8.4, dark = false } = {}) {
        const { w, h, style } = this.badgeSize(label, px);
        const m = this.fontMetrics(style.font);
        const textH = (m.asc - m.desc) * style.size;
        const fill = dark ? meta.darkBg : meta.bg;
        const color = dark ? meta.darkColor : meta.color;
        const stroke = dark ? meta.darkBorder : null;
        this.roundedBox(x, y, w, h, s(2), { fill, stroke, lineWidth: s(0.75) });
        this.doc.font(style.font).fontSize(style.size).fillColor(color)
            .text(label, x + s(6), y + (h - textH) / 2, { lineBreak: false });
        return { w, h };
    }

    /* ---------- 패키지 심각도 분포 가로 막대 (보고서용 직선형) ---------- */
    drawDistBar(counts, total, x, y, w, barH = s(5)) {
        this.rect(x, y, w, barH, C.hairline);
        if (total <= 0) return;

        const active = SEVERITY_ORDER.filter((sev) => (counts[sev] ?? 0) > 0);
        const gap = active.length > 1 ? 1.2 : 0;
        const usableW = Math.max(4, w - gap * (active.length - 1));
        const rawW = active.map((sev) => Math.max(3, (counts[sev] / total) * usableW));
        const scale = usableW / rawW.reduce((a, b) => a + b, 0);

        let bx = x;
        active.forEach((sev, idx) => {
            const segW = rawW[idx] * scale;
            this.rect(bx, y, segW, barH, SEVERITY_META[sev].dot);
            bx += segW + gap;
        });
    }

    /* ---------- 보안 진단 보고서 직선형 테이블 (둥근 모서리 제거 · 연한 가로선) ---------- */
    table({
        columns,
        header,
        rows,
        headStyle = st('M', 8.8, C.inkNav),
        padHead = { v: s(7.5), h: s(8) },
        padBody = { v: s(8.5), h: s(8) },
        lh = 1.4,
        valign = 'middle',
        marginTop = s(6),
        marginBottom = s(14)
    }) {
        const totalW = columns.reduce((a, c) => a + c.w, 0);
        const sDistCount = st('B', 9.2, C.ink);

        const measureCell = (cell, colW, pad) => {
            const innerW = colW - pad.h * 2;
            if (cell.dist) {
                const row1H = sDistCount.size * 1.2;
                const subH = cell.distSub ? this.measure(cell.distSub, innerW, { lh: 1.25 }) + s(3) : 0;
                return row1H + subH;
            }
            if (cell.severity) return this.badgeSize((SEVERITY_META[cell.severity] ?? SEVERITY_META.UNKNOWN).label).h;
            return this.measure(cell.runs, innerW, { lh: cell.lh ?? lh, wrap: cell.wrap ?? 'normal' });
        };

        const drawCell = (cell, x, y, colW, rowH, pad, align) => {
            const innerW = colW - pad.h * 2;
            const h = measureCell(cell, colW, pad);
            const top = valign === 'middle' ? y + (rowH - h) / 2 : y + pad.v;
            if (cell.dist) {
                const countLabel = `${cell.dist.total}건`;
                const countW = s(28);
                const barGap = s(8);
                const barW = Math.max(s(32), innerW - countW - barGap);
                const barH = s(5);
                const row1H = sDistCount.size * 1.2;
                const barY = top + (row1H - barH) / 2;
                this.drawDistBar(cell.dist.counts, cell.dist.total, x + pad.h, barY, barW, barH);
                this.text([{ ...sDistCount, text: countLabel }], x + pad.h + barW + barGap, top, countW, { lh: 1.2, wrap: 'none', align: 'right' });
                if (cell.distSub) {
                    this.text(cell.distSub, x + pad.h, top + row1H + s(3), innerW, { lh: 1.25, wrap: 'normal' });
                }
                return;
            }
            if (cell.severity) {
                this.badge(cell.severity, x + pad.h, top);
                return;
            }
            this.text(cell.runs, x + pad.h, top, innerW, { lh: cell.lh ?? lh, wrap: cell.wrap ?? 'normal', align });
        };

        const headerCells = header.map((h) => (h.runs ? h : { runs: [{ ...headStyle, text: h }], wrap: 'none', lh: 1.15 }));
        const rowHeight = (cells, pad) => Math.max(...cells.map((cell, i) => measureCell(cell, columns[i].w, pad))) + pad.v * 2;
        const headH = rowHeight(headerCells, padHead);
        const rowHeights = rows.map((r) => rowHeight(r, padBody));

        this.y += marginTop;
        if (rows.length > 0) this.ensure(headH + rowHeights[0] + s(4));

        // 페이지 단위로 청크 분할 후 직선형 보고서 테이블 렌더링
        let cursor = 0;
        while (cursor < rows.length || (rows.length === 0 && cursor === 0)) {
            if (cursor > 0) this.newPage();
            const avail = BOTTOM - this.y;
            const chunk = [];
            let bodyH = 0;
            while (cursor < rows.length && (chunk.length === 0 || headH + bodyH + rowHeights[cursor] <= avail)) {
                chunk.push({ cells: rows[cursor], h: rowHeights[cursor] });
                bodyH += rowHeights[cursor];
                cursor += 1;
            }

            const frameY = this.y;
            const frameH = headH + bodyH;

            // 직각 헤더 배경 + 상단 연한 경계선
            this.rect(MX, frameY, totalW, headH, C.surface);
            this.hline(MX, MX + totalW, frameY, C.line, s(0.8));

            // 헤더 내용
            let hx = MX;
            headerCells.forEach((cell, i) => {
                drawCell(cell, hx, frameY, columns[i].w, headH, padHead, columns[i].align ?? 'left');
                hx += columns[i].w;
            });
            this.hline(MX, MX + totalW, frameY + headH, C.line, s(0.85));

            // 행 내용
            let ry = frameY + headH;
            chunk.forEach(({ cells, h }, rIdx) => {
                if (rIdx > 0) this.hline(MX, MX + totalW, ry, C.hairline, s(0.75));
                let cx = MX;
                cells.forEach((cell, i) => {
                    drawCell(cell, cx, ry, columns[i].w, h, padBody, columns[i].align ?? 'left');
                    cx += columns[i].w;
                });
                ry += h;
            });

            // 하단 마감선
            this.hline(MX, MX + totalW, frameY + frameH, C.line, s(0.85));
            this.y = frameY + frameH;

            if (rows.length === 0) break;
        }
        this.y += marginBottom;
    }
}

/* =========================================================================
   AutoSCA 시그니처 도트 웨이브 배경 (HomeWaveCanvas 벡터 구현)
   ========================================================================= */
function drawHeroDotWave(doc, x, y, w, h) {
    doc.save();
    doc.rect(x, y, w, h).clip();
    const spacing = 11.5;
    const cols = Math.ceil(w / spacing) + 1;
    const rows = Math.ceil(h / spacing) + 1;

    for (let r = 0; r < rows; r++) {
        const py = y + r * spacing;
        const ny = (py - y) / h;
        for (let c = 0; c < cols; c++) {
            const px = x + c * spacing;
            const nx = (px - x) / w;
            // AutoSCA HomeWaveCanvas 와 유사한 사인 곡선 웨이브 리지
            const ridge1 = 0.62 + 0.19 * Math.sin(nx * 5.2 + 0.4) + 0.08 * Math.cos(nx * 9.5);
            const ridge2 = 0.78 + 0.14 * Math.sin(nx * 4.1 + 1.9);
            const d1 = Math.abs(ny - ridge1);
            const d2 = Math.abs(ny - ridge2);
            const intensity = Math.max(
                Math.exp(-(d1 * d1) / 0.022),
                Math.exp(-(d2 * d2) / 0.032) * 0.75
            );
            if (intensity < 0.12) continue;

            // 좌측 텍스트 영역은 은은하게, 우측/하단은 선명하게
            const fade = 0.35 + 0.65 * Math.min(1, nx * 1.15);
            const alpha = Math.min(0.42, intensity * 0.36 * fade);
            const radius = 0.75 + intensity * 0.95;
            const color = intensity > 0.68 ? C.primary : '#ffffff';
            doc.circle(px, py, radius).fillColor(color, alpha).fill();
        }
    }
    doc.fillOpacity(1);
    doc.restore();
}

/* =========================================================================
   3종 스캐너 벤 다이어그램 (표지 '탐지' 영역)
   ========================================================================= */
function drawMiniVenn(r, vulnerabilities, x, y, width) {
    const { doc } = r;
    const venn = computeVennCounts(vulnerabilities);
    const scale = width / VENN_GEO.vbW;
    const height = VENN_GEO.vbH * scale;

    doc.save();
    doc.translate(x - VENN_GEO.vbX * scale, y - VENN_GEO.vbY * scale).scale(scale);
    for (const region of VENN_GEO.regions) {
        const cnt = venn.regions[region.key] ?? 0;
        const style = VENN_REGION_COLORS[region.key];
        doc.path(region.d).fillColor(style.fill, cnt > 0 ? style.opacity : 0.04).fill();
    }
    doc.fillOpacity(1);
    for (const circle of VENN_GEO.circles) {
        doc.circle(circle.x, circle.y, circle.r)
            .lineWidth(1.6)
            .strokeColor(TOOL_COLORS[circle.id], 0.85)
            .stroke();
    }
    doc.strokeOpacity(1);
    doc.restore();

    const fontRatio = width / s(122);
    for (const region of VENN_GEO.regions) {
        const cnt = venn.regions[region.key] ?? 0;
        const rx = x + (region.lx - VENN_GEO.vbX) * scale;
        const ry = y + (region.ly - VENN_GEO.vbY) * scale;
        const basePx = cnt >= 100 ? 6.8 : 7.8;
        const stNum = st(region.isCenter && cnt > 0 ? 'B' : 'M', basePx * fontRatio, cnt > 0 ? C.ink : C.muted);
        const tw = r.width(String(cnt), stNum);
        const tm = r.fontMetrics(stNum.font);
        const opticalTop = ry + 0.34 * stNum.size - tm.asc * stNum.size;
        doc.font(stNum.font).fontSize(stNum.size).fillColor(stNum.color)
            .text(String(cnt), rx - tw / 2, opticalTop, { lineBreak: false });
    }
    return { height, venn };
}

/* =========================================================================
   언어별 취약점 집계 & 세로 누적 막대 (Front-end ReportSummary '언어' 1:1)
   ========================================================================= */
function buildLanguageSummary(vulnerabilities, fallbackEcosystems = []) {
    const map = new Map();
    let countedTotal = 0;

    for (const v of vulnerabilities) {
        const raw = String(v.package?.ecosystem ?? '').trim();
        if (!raw) continue;
        const lang = resolveLanguage(raw);
        if (!map.has(lang.key)) {
            map.set(lang.key, { key: lang.key, label: lang.label, color: lang.color, count: 0, rawEcosystems: new Set() });
        }
        const entry = map.get(lang.key);
        entry.count += 1;
        entry.rawEcosystems.add(raw.toLowerCase());
        countedTotal += 1;
    }

    if (map.size === 0 && fallbackEcosystems.length > 0) {
        for (const raw of fallbackEcosystems) {
            const clean = String(raw ?? '').trim();
            if (!clean) continue;
            const lang = resolveLanguage(clean);
            if (!map.has(lang.key)) {
                map.set(lang.key, { key: lang.key, label: lang.label, color: lang.color, count: 0, rawEcosystems: new Set() });
            }
            map.get(lang.key).rawEcosystems.add(clean.toLowerCase());
        }
    }

    return [...map.values()]
        .map((entry) => ({
            key: entry.key,
            label: entry.label,
            color: entry.color,
            count: entry.count,
            pct: countedTotal > 0 ? Math.round((entry.count / countedTotal) * 100) : 0,
            rawEcosystems: [...entry.rawEcosystems]
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function readableStatColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return C.ink;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    // 밝은 노랑/연두 계열(예: JavaScript #e5b822)은 흰 배경 수치 가독성을 위해 명도만 살짝 보정
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (luma > 0.62) {
        const factor = 0.60 / luma;
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
    }
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function drawLanguageVerticalBar(r, languages, x, y, trackW, trackH) {
    const { doc } = r;
    const outerRad = Math.min(s(6), trackW * 0.36);

    const active = languages.filter((item) => item.count > 0);
    const countSum = active.reduce((acc, item) => acc + item.count, 0);
    if (countSum <= 0 || active.length === 0) {
        // 취약점 0건 시 회색 배경 없이 연한 윤곽선만 표시
        r.roundedBox(x, y, trackW, trackH, outerRad, { stroke: C.line, lineWidth: s(1.1) });
        return;
    }

    const gap = active.length > 1 ? s(3) : 0;
    const usableH = Math.max(s(10), trackH - gap * (active.length - 1));

    // Front-end ReportSummary(.cf-rpt-lang-vtrack) 와 동일한 최소 6% 가중치 보정
    const weights = active.map((item) => Math.max(item.count, countSum * 0.06));
    const weightSum = weights.reduce((acc, w) => acc + w, 0);

    doc.save();
    doc.roundedRect(x, y, trackW, trackH, outerRad).clip();
    let cy = y;
    active.forEach((item, idx) => {
        const isLast = idx === active.length - 1;
        const segH = isLast ? Math.max(s(5), y + trackH - cy) : (weights[idx] / weightSum) * usableH;
        const rad = active.length === 1 ? outerRad : Math.min(s(3.8), segH / 2);
        doc.roundedRect(x, cy, trackW, segH, rad).fill(item.color);
        cy += segH + gap;
    });
    doc.restore();
}

/* =========================================================================
   심각도 도넛 차트 (표지 '심각도' 영역)
   ========================================================================= */
function drawSeverityDonut(r, bySeverity, total, x, y, size) {
    const { doc } = r;
    const isSafe = total === 0;
    const dScale = size / 200;

    doc.save();
    doc.translate(x - 8 * dScale, y - 8 * dScale).scale(dScale);
    if (isSafe) {
        doc.circle(108, 108, 81).lineWidth(22).strokeColor(SEVERITY_META.SAFE.dot).stroke();
    } else {
        const visibleSevs = SEVERITY_ORDER.filter((sev) => (bySeverity?.[sev] ?? 0) > 0);
        const slices = buildDonutSlices(visibleSevs, bySeverity, total);
        for (const sl of slices) {
            const fill = SEVERITY_META[sl.sev].dot;
            if (sl.isFullRing) {
                doc.circle(108, 108, 81).lineWidth(22).strokeColor(fill).stroke();
            } else {
                doc.path(sl.d).fill(fill);
            }
        }
    }
    doc.restore();

    const ratio = size / s(104);
    const numText = isSafe ? '0' : String(total);
    const subText = isSafe ? 'SAFE' : '전체 취약점';
    const numPx = (numText.length >= 4 ? 15 : 19) * ratio;
    const subPx = 7.6 * ratio;
    const sNum = st('B', numPx, isSafe ? SEVERITY_META.SAFE.color : C.ink);
    const sSub = st('M', subPx, isSafe ? SEVERITY_META.SAFE.color : C.inkMeta);
    const gapY = s(2.5) * ratio;
    const blockH = sNum.size * 1.12 + gapY + sSub.size * 1.2;
    const top = y + (size - blockH) / 2;
    r.text({ ...sNum, text: numText }, x, top, size, { lh: 1.12, wrap: 'none', align: 'center' });
    r.text({ ...sSub, text: subText }, x, top + sNum.size * 1.12 + gapY, size, { lh: 1.2, wrap: 'none', align: 'center' });
}

/* =========================================================================
   공통 Kumo 섹션 헤더 (SECTION 0X 라벨 없이 깔끔한 타이틀 + 우측 카운트)
   ========================================================================= */
function drawSectionHeader(r, heading, rightBadge = '', marginBottom = s(12)) {
    const y = r.y;
    const hStyle = st('B', 16.5, C.ink);
    const headEnd = r.text({ ...hStyle, text: heading }, MX, y, CW - s(90), { lh: 1.25 });

    if (rightBadge) {
        r.text(st('M', 9.5, C.inkMeta, { text: rightBadge }), MX, y + s(4), CW, { wrap: 'none', align: 'right' });
    }
    r.y = headEnd + marginBottom;
}

/* =========================================================================
   1페이지: 표지 겸 핵심 요약 (히어로 + 심각도 · 탐지 · 언어 3단 풀-페이지 레이아웃)
   ========================================================================= */
function drawCover(r, data, targetSource, generatedAt, avatarBuf = null) {
    const { doc } = r;
    const { summary, inputs, vulnerabilities } = data;
    const targetName = formatTargetName(targetSource);
    const isUrl = /^https?:\/\//i.test(targetSource ?? '');

    const ecosystems = data.target?.ecosystems?.length
        ? data.target.ecosystems
        : [...new Set(vulnerabilities.map((v) => v.package?.ecosystem).filter(Boolean))];
    const total = summary.total || 0;

    // ── 상단 Kumo 미니멀 바 ──
    const chromeH = s(38);
    r.rect(0, 0, PAGE_W, chromeH, C.canvas);
    r.hline(0, PAGE_W, chromeH, C.line, s(0.8));
    const chromeTextY = (chromeH - s(10) * 1.4) / 2;
    r.text(st('B', 11.5, C.ink, { text: 'AutoSCA' }), MX, chromeTextY, CW * 0.5, { wrap: 'none' });
    r.text(st('R', 9.2, C.ink, { text: `점검 일시: ${generatedAt}` }), MX, chromeTextY + s(0.5), CW, { wrap: 'none', align: 'right' });

    // ── AutoSCA Kumo Dark 도트 웨이브 히어로 (좌측 정렬 유지: .cf-hero-heading 타이포 + 아바타/저장소명) ──
    const heroY = chromeH + s(0.8);
    const padV = s(29);
    const heroTitleText = 'Open Source 취약점 진단 보고서';
    const sHeroHeading = st('B', 28, '#ededed');
    const heroCharSpacing = -0.35;
    const hm = r.fontMetrics(sHeroHeading.font);
    const headingH = (hm.asc - hm.desc) * sHeroHeading.size;

    const avatarSize = s(32);
    const avatarGap = s(11);
    const repoTextX = MX + avatarSize + avatarGap;
    const repoTextW = CW - avatarSize - avatarGap;
    const sRepoName = st('M', 15, '#ededed');
    const repoLaid = r.layout([{ ...sRepoName, text: targetName, link: isUrl ? targetSource : undefined }], repoTextW, {
        lh: 1.25,
        wrap: 'anywhere'
    });
    const repoRowH = Math.max(avatarSize, repoLaid.height);
    const gapBetween = s(14);
    const heroH = padV * 2 + headingH + gapBetween + repoRowH;

    r.rect(0, heroY, PAGE_W, heroH, C.heroBg);
    drawHeroDotWave(doc, 0, heroY, PAGE_W, heroH);

    // 좌측 정렬 타이틀: "Open Source 취약점 진단 보고서"
    const titleY = heroY + padV;
    doc.font(sHeroHeading.font)
        .fontSize(sHeroHeading.size)
        .fillColor(sHeroHeading.color)
        .text(heroTitleText, MX, titleY, { lineBreak: false, characterSpacing: heroCharSpacing });

    // 하단 좌측 정렬: 저장소 프로필 아바타 + 저장소명
    const repoRowY = titleY + headingH + gapBetween;
    const ax = MX;
    const ay = repoRowY + (repoRowH - avatarSize) / 2;
    const avatarRad = s(7);
    if (avatarBuf) {
        try {
            doc.save();
            doc.roundedRect(ax, ay, avatarSize, avatarSize, avatarRad).clip();
            r.rect(ax, ay, avatarSize, avatarSize, C.heroCard);
            doc.image(avatarBuf, ax, ay, { width: avatarSize, height: avatarSize });
            doc.restore();
            r.roundedBox(ax, ay, avatarSize, avatarSize, avatarRad, { stroke: C.heroLine, lineWidth: s(0.9) });
        } catch {
            avatarBuf = null;
        }
    }
    if (!avatarBuf) {
        r.roundedBox(ax, ay, avatarSize, avatarSize, avatarRad, { fill: C.heroCard, stroke: C.heroLine, lineWidth: s(0.9) });
        const initial = (extractGithubOwner(targetSource) || targetName || 'A')[0].toUpperCase();
        const sInit = st('B', 13.5, '#ededed');
        const im = r.fontMetrics(sInit.font);
        const ih = (im.asc - im.desc) * sInit.size;
        const iw = r.width(initial, sInit);
        doc.font(sInit.font).fontSize(sInit.size).fillColor(sInit.color)
            .text(initial, ax + (avatarSize - iw) / 2, ay + (avatarSize - ih) / 2, { lineBreak: false });
    }
    if (isUrl) doc.link(ax, ay, avatarSize, avatarSize, targetSource);

    if (repoLaid.lines.length === 1) {
        const rm = r.fontMetrics(sRepoName.font);
        const avatarMidY = ay + avatarSize / 2;
        const opticalBaseline = avatarMidY + 0.34 * sRepoName.size;
        const opticalTop = opticalBaseline - rm.asc * sRepoName.size;
        doc.font(sRepoName.font)
            .fontSize(sRepoName.size)
            .fillColor(sRepoName.color)
            .text(targetName, repoTextX, opticalTop, { lineBreak: false });
        if (isUrl) doc.link(repoTextX, ay, repoLaid.width, avatarSize, targetSource);
    } else {
        const opticalShift = 0.095 * sRepoName.size;
        const repoTextY = repoRowY + (repoRowH - repoLaid.height) / 2 - opticalShift;
        r.drawLines(repoLaid, repoTextX, repoTextY, repoTextW);
    }

    // ── 표지 본문: AutoSCA 란 + 심각도 · 탐지 · 언어 (구분선 없이 여백으로 섹션 분리) ──
    const sBandTitle = st('B', 15, C.ink);
    const rightColX = MX + s(146);
    const rightColW = MX + CW - rightColX;
    const sectionGap = s(46);

    // ── 0. AutoSCA 란 (AutoSCA 플랫폼 소개) ──
    let curY = heroY + heroH + s(26);
    curY = r.text({ ...sBandTitle, text: 'AutoSCA 란' }, MX, curY, CW, { lh: 1.25 }) + s(7);

    const sIntro = st('R', 9.2, C.inkBody);
    const sIntroStrong = st('M', 9.2, C.ink);
    const introRuns = [
        { ...sIntroStrong, text: 'AutoSCA' },
        {
            ...sIntro,
            text: '는 SCA(Software Composition Analysis) 기반 오픈소스 취약점 교차 진단 플랫폼입니다. 격리된 샌드박스 환경에서 대상 저장소의 의존성을 분석하고, OSV-Scanner · Grype · Trivy 3종의 보안 스캐너로 교차 검증을 수행하여 단일 도구 기반 점검의 오탐과 미탐을 최소화합니다. 본 보고서는 점검 시점에 식별된 취약점의 심각도 분포, 스캐너별 탐지 현황, 언어별 영향 범위 및 패키지별 권장 패치 버전을 정리하여 선제적인 오픈소스 공급망 보안 대응을 지원합니다. '
        },
        { ...st('M', 9.2, C.link), text: 'autosca.cloud', link: 'https://autosca.cloud' }
    ];
    const introEnd = r.text(introRuns, MX, curY, CW, { lh: 1.54 });

    // ── 1. 심각도 (산정 기준 설명 + 컴팩트 도넛 차트 + 5등급 KPI) ──
    curY = introEnd + sectionGap;
    curY = r.text({ ...sBandTitle, text: '심각도' }, MX, curY, CW, { lh: 1.25 }) + s(7);
    curY = r.text(
        {
            ...sIntro,
            text: '심각도는 국제 표준 취약점 위험도 점수인 CVSS(CRITICAL 9.0–10.0 · HIGH 7.0–8.9 · MEDIUM 4.0–6.9 · LOW 0.1–3.9 · UNKNOWN 미산정)를 기준으로 분류됩니다. 동일 취약점이 여러 스캐너에서 중복 탐지된 경우, 보수적 대응을 위해 각 스캐너 판정 중 가장 높은 심각도와 최고 CVSS 점수를 채택합니다.'
        },
        MX,
        curY,
        CW,
        { lh: 1.54 }
    ) + s(15);

    const donutSize = s(96);
    const donutY = curY;
    drawSeverityDonut(r, summary.bySeverity, total, MX, donutY, donutSize);

    const sStatLbl = st('B', 9, C.inkNav);
    const sStatNum = st('B', 22.5, C.ink);
    const sStatPct = st('R', 8.8, C.inkMeta);
    const col5W = rightColW / 5;
    const kpiBlockH = s(16) + s(25) + sStatPct.size * 1.3;
    const kpiTop = donutY + (donutSize - kpiBlockH) / 2;

    SEVERITY_ORDER.forEach((sev, idx) => {
        const meta = SEVERITY_META[sev];
        const count = summary.bySeverity?.[sev] ?? 0;
        const pct = total > 0 ? `${Math.round((count / total) * 100)}%` : '0%';
        const x = rightColX + col5W * idx;
        const w = col5W - s(4);

        let y = kpiTop;
        r.text([{ dot: meta.dot, r: s(2.7), size: sStatLbl.size }, { ...sStatLbl, text: meta.label }], x, y, w, { lh: 1.35, wrap: 'none' });
        y += s(16);
        r.text({ ...sStatNum, color: count > 0 ? meta.color : C.muted, text: String(count) }, x, y, w, { lh: 1.05, wrap: 'none' });
        y += s(25);
        r.text({ ...sStatPct, text: pct }, x, y, w, { lh: 1.3, wrap: 'none' });
    });

    // ── 2. 탐지 (스캐너별 서브타이틀 & 하단 설명 + 벤 다이어그램 · 4열 KPI) ──
    curY = donutY + donutSize + sectionGap;
    curY = r.text({ ...sBandTitle, text: '탐지' }, MX, curY, CW, { lh: 1.25 }) + s(9);

    const scannerIntros = [
        {
            name: 'OSV-Scanner',
            desc: '락파일·SBOM·소스 디렉터리에서 추출한 패키지 버전과 커밋 해시를 OpenSSF 표준 분산 취약점 데이터베이스(OSV.dev)와 대조해 취약점을 식별합니다. Google 오픈소스 보안팀이 개발·유지보수하며, 각 언어 생태계 공식 보안 권고와 GitHub Advisory 데이터를 직접 참조합니다.'
        },
        {
            name: 'Grype',
            desc: '파일시스템과 SBOM에서 언어별 라이브러리 및 OS 패키지 의존성을 추출해 NVD·GHSA·배포판 보안 권고와 대조하여 알려진 CVE를 탐지합니다. 소프트웨어 공급망 보안 및 SBOM 도구 기업 Anchore가 개발하며, 취약점별 EPSS(악용 확률)와 CISA KEV(실제 악용 목록) 지표를 함께 제공합니다.'
        },
        {
            name: 'Trivy',
            desc: '코드 저장소 내 패키지 매니저 락파일과 의존성 목록을 분석해 NVD 및 각 언어·OS 벤더 보안 권고와 비교하고, 영향 범위와 수정 버전을 식별합니다. 클라우드 네이티브 보안 기업 Aqua Security가 개발·유지보수하는 오픈소스 스캐너로, 다수의 언어 생태계와 폭넓은 취약점 피드를 지원합니다.'
        }
    ];
    const sSubTitle = st('B', 10.2, C.ink);

    scannerIntros.forEach((item, idx) => {
        curY = r.text({ ...sSubTitle, text: item.name }, MX, curY, CW, { lh: 1.45, wrap: 'none' }) + s(2);
        curY = r.text({ ...sIntro, text: item.desc }, MX, curY, CW, { lh: 1.5 })
            + (idx < scannerIntros.length - 1 ? s(8.5) : s(15));
    });

    const vennW = s(106);
    const vennY = curY;
    const { height: vennH } = drawMiniVenn(r, vulnerabilities, MX, vennY, vennW);

    // 심각도와 동일한 KPI 폼: 좌측 3종 스캐너 | 연한 세로 구분선 | 우측 2종 이상 공통 (점 없음 · 검은색 수치)
    const multiCount = summary.detectedByMultipleTools ?? vulnerabilities.filter((v) => (v.detectedBy?.length ?? 0) > 1).length;
    const scanAreaW = rightColW * 0.71;
    const scanColW = scanAreaW / VENN_SCANNERS.length;
    const detKpiTop = vennY + (vennH - kpiBlockH) / 2;

    VENN_SCANNERS.forEach((name, idx) => {
        const unused = inputs?.[name]?.used === false;
        const count = summary.byTool?.[name] ?? 0;
        const pct = unused ? '-' : (total > 0 ? `${Math.round((count / total) * 100)}%` : '0%');
        const x = rightColX + scanColW * idx;
        const w = scanColW - s(4);

        let y = detKpiTop;
        r.text([{ dot: TOOL_COLORS[name], r: s(2.7), size: sStatLbl.size }, { ...sStatLbl, text: TOOL_LABELS[name] }], x, y, w, { lh: 1.35, wrap: 'none' });
        y += s(16);
        if (unused) {
            r.text({ ...st('B', 13.5, C.muted), text: '미사용' }, x, y + s(4.5), w, { lh: 1.1, wrap: 'none' });
        } else {
            r.text({ ...sStatNum, color: count > 0 ? TOOL_COLORS[name] : C.muted, text: String(count) }, x, y, w, { lh: 1.05, wrap: 'none' });
        }
        y += s(25);
        r.text({ ...sStatPct, text: pct }, x, y, w, { lh: 1.3, wrap: 'none' });
    });

    // 연한 세로 구분선 + 우측 2종 이상 공통 (점 제거, 검은색 수치)
    const sepX = rightColX + scanAreaW + s(4);
    r.vline(sepX, detKpiTop + s(1), detKpiTop + kpiBlockH - s(2), C.line, s(0.85));
    const multiX = sepX + s(18);
    const multiW = MX + CW - multiX;
    const multiPct = total > 0 ? `${Math.round((multiCount / total) * 100)}%` : '0%';
    let my = detKpiTop;
    r.text({ ...sStatLbl, text: '2종 이상 공통' }, multiX, my, multiW, { lh: 1.35, wrap: 'none' });
    my += s(16);
    r.text({ ...sStatNum, color: multiCount > 0 ? C.ink : C.muted, text: String(multiCount) }, multiX, my, multiW, { lh: 1.05, wrap: 'none' });
    my += s(25);
    r.text({ ...sStatPct, text: multiPct }, multiX, my, multiW, { lh: 1.3, wrap: 'none' });

    // ── 3. 언어 (분류 기준 설명 + 웹과 동일한 단일 세로 누적 막대 + 우측 동일 기준선 KPI 열) ──
    curY = vennY + vennH + sectionGap;
    curY = r.text({ ...sBandTitle, text: '언어' }, MX, curY, CW, { lh: 1.25 }) + s(7);
    curY = r.text(
        {
            ...sIntro,
            text: '저장소의 락파일·매니페스트에서 식별된 패키지 매니저(npm, PyPI, crates.io 등)를 기준으로 취약점을 언어별로 집계합니다. 동일 언어에 속하는 패키지 매니저는 하나로 통합하며, 탐지 언어가 5개를 초과하는 경우 상위 4개 언어와 기타 항목으로 구분해 표시합니다.'
        },
        MX,
        curY,
        CW,
        { lh: 1.54 }
    ) + s(15);

    const allLanguages = buildLanguageSummary(vulnerabilities, ecosystems);
    const langCountSum = allLanguages.reduce((acc, item) => acc + item.count, 0);
    let displayLangs = allLanguages;
    if (allLanguages.length > 5) {
        const head = allLanguages.slice(0, 4);
        const tail = allLanguages.slice(4);
        const restCount = tail.reduce((acc, item) => acc + item.count, 0);
        displayLangs = [
            ...head,
            {
                key: '__rest__',
                label: `기타 (${tail.length}개)`,
                color: '#8c95a3',
                count: restCount,
                pct: langCountSum > 0 ? Math.round((restCount / langCountSum) * 100) : 0,
                rawEcosystems: []
            }
        ];
    }

    const trackW = s(17);
    const trackH = s(92);
    const trackX = MX + (donutSize - trackW) / 2;
    const trackY = curY;
    drawLanguageVerticalBar(r, displayLangs, trackX, trackY, trackW, trackH);

    const langKpiTop = trackY + (trackH - kpiBlockH) / 2;
    if (displayLangs.length === 0) {
        const emptyH = s(9.5) * 1.4;
        r.text(st('R', 9.5, C.muted, { text: '식별된 언어 생태계 없음' }), rightColX, trackY + (trackH - emptyH) / 2, rightColW, { lh: 1.4, wrap: 'none' });
    } else {
        const langColCount = Math.max(4, displayLangs.length);
        const langColW = rightColW / langColCount;
        const sLangEco = st('R', 8, C.inkMeta);
        displayLangs.forEach((lang, idx) => {
            const x = rightColX + langColW * idx;
            const w = langColW - s(5);
            const pctStr = langCountSum > 0
                ? (lang.count > 0 && lang.pct === 0 ? '<1%' : `${lang.pct}%`)
                : '0%';
            const ecoText = lang.rawEcosystems?.length
                ? (lang.rawEcosystems.length > 1
                    ? `${lang.rawEcosystems[0]} +${lang.rawEcosystems.length - 1}`
                    : lang.rawEcosystems[0])
                : '';

            const dotW = s(2.7) * 2 + s(4);
            const ecoGap = s(4.5);
            const showEco = ecoText && (dotW + r.width(lang.label, sStatLbl) + ecoGap + r.width(ecoText, sLangEco) <= w);
            const labelRuns = [
                { dot: lang.color, r: s(2.7), size: sStatLbl.size },
                { ...sStatLbl, text: lang.label },
                ...(showEco ? [{ gap: ecoGap }, { ...sLangEco, text: ecoText }] : [])
            ];

            let y = langKpiTop;
            r.text(labelRuns, x, y, w, { lh: 1.35, wrap: 'none' });
            y += s(16);
            r.text({ ...sStatNum, color: lang.count > 0 ? readableStatColor(lang.color) : C.muted, text: String(lang.count) }, x, y, w, { lh: 1.05, wrap: 'none' });
            y += s(25);
            r.text({ ...sStatPct, text: pctStr }, x, y, w, { lh: 1.3, wrap: 'none' });
        });
    }

    r.y = trackY + trackH;
}

/* =========================================================================
   패키지별 취약점 (2페이지 시작, 웹 ReportTable packages 탭 4열 1:1 동기화)
   ========================================================================= */
function buildVersionInlineRuns(currentVer, fixText, altFixes = []) {
    const sCur = st('R', 9.2, C.inkMeta);
    const sArrow = st('R', 9, C.muted);
    const sTarget = st('B', 9.2, C.link);
    const sSuffix = st('R', 8.5, C.inkMeta);
    const sNone = st('R', 8.8, C.muted);

    if (!fixText) {
        return [
            { ...sCur, text: String(currentVer) },
            { ...sArrow, text: '  ·  ' },
            { ...sNone, text: '패치 미정' }
        ];
    }

    const hasSuffix = /\s+이상$/.test(fixText);
    const targetNum = hasSuffix ? fixText.replace(/\s+이상$/, '').trim() : fixText;
    const runs = [
        { ...sCur, text: String(currentVer) },
        { ...sArrow, text: '  →  ' },
        { ...sTarget, text: targetNum },
        ...(hasSuffix ? [{ ...sSuffix, text: ' 이상' }] : [])
    ];
    for (const alt of altFixes) {
        runs.push({ ...sSuffix, text: `  또는 ${alt}` });
    }
    return runs;
}

function drawPackagePriority(r, vulnerabilities) {
    if (vulnerabilities.length === 0) return;

    const pkgMap = new Map();
    for (const vuln of vulnerabilities) {
        const key = `${vuln.package.name}@${vuln.package.version}`;
        if (!pkgMap.has(key)) {
            pkgMap.set(key, {
                name: vuln.package.name,
                version: vuln.package.version,
                ecosystem: vuln.package.ecosystem,
                total: 0,
                counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
                maxScore: null,
                highestSeverity: 'UNKNOWN',
                fixedVersions: new Set()
            });
        }
        const entry = pkgMap.get(key);
        entry.total++;
        entry.counts[vuln.severity] = (entry.counts[vuln.severity] ?? 0) + 1;
        if (SEVERITY_ORDER.indexOf(vuln.severity) < SEVERITY_ORDER.indexOf(entry.highestSeverity)) entry.highestSeverity = vuln.severity;
        if (vuln.cvssScore != null && (entry.maxScore == null || vuln.cvssScore > entry.maxScore)) entry.maxScore = vuln.cvssScore;
        (vuln.fixedVersions ?? []).forEach((v) => entry.fixedVersions.add(v));
    }

    const sorted = [...pkgMap.values()].sort(
        (a, b) =>
            SEVERITY_ORDER.indexOf(a.highestSeverity) - SEVERITY_ORDER.indexOf(b.highestSeverity)
            || b.total - a.total
            || (b.maxScore ?? 0) - (a.maxScore ?? 0)
    );

    const name = st('M', 9.6, C.ink);
    const cvssStyle = st('R', 8.8, C.inkMeta);
    const distLabelStyle = st('B', 7.8, C.inkNav);
    const distCountStyle = st('R', 7.8, C.inkMeta);
    const distSepStyle = st('R', 7.8, C.muted);

    const rows = sorted.map((pkg) => {
        const sevMeta = SEVERITY_META[pkg.highestSeverity] ?? SEVERITY_META.UNKNOWN;
        const fixes = pickRecommendedFixes([...pkg.fixedVersions], pkg.version);
        const fixText = fixes.length
            ? fixes[0]
            : (pkg.fixedVersions.size ? `${[...pkg.fixedVersions][0]} 이상` : '');
        const breakdownRuns = [];
        SEVERITY_ORDER.filter((sev) => pkg.counts[sev] > 0).forEach((sev, si) => {
            const m = SEVERITY_META[sev] ?? SEVERITY_META.UNKNOWN;
            if (si > 0) breakdownRuns.push({ ...distSepStyle, text: ' · ' });
            breakdownRuns.push({ ...distLabelStyle, text: m.label });
            breakdownRuns.push({ gap: s(3) });
            breakdownRuns.push({ ...distCountStyle, text: String(pkg.counts[sev]) });
        });

        const sevRuns = [
            { ...st('B', 9, sevMeta.color), text: sevMeta.label },
            ...(pkg.maxScore != null ? [{ gap: s(6) }, { ...cvssStyle, text: Number(pkg.maxScore).toFixed(1) }] : [])
        ];

        return [
            { runs: sevRuns, wrap: 'none' },
            { runs: [{ ...name, text: pkg.name }], wrap: 'anywhere' },
            { runs: buildVersionInlineRuns(pkg.version, fixText), wrap: 'normal' },
            {
                dist: { counts: pkg.counts, total: pkg.total },
                distSub: breakdownRuns
            }
        ];
    });

    r.newPage();
    drawSectionHeader(r, '패키지별 취약점', '', s(7));
    r.y = r.text(
        {
            ...st('R', 9.2, C.inkBody),
            text: '동일 패키지와 설치 버전에서 탐지된 취약점을 하나로 묶어, 최고 심각도·취약점 건수·최고 CVSS 점수 순으로 정렬합니다. 권장 패치 버전은 현재 설치된 메이저 버전 범위 내 수정 버전을 우선 제시하며, 공식 패치가 공개되지 않은 항목은 ‘패치 미정’으로 표기합니다.'
        },
        MX,
        r.y,
        CW,
        { lh: 1.54 }
    ) + s(12);
    r.y = r.text(st('M', 9, C.inkMeta, { text: `${sorted.length}개` }), MX, r.y, CW, { lh: 1.25, wrap: 'none', align: 'right' }) + s(5);
    const widths = [19, 25, 26, 30];
    const aligns = ['left', 'left', 'left', 'left'];
    r.table({
        columns: widths.map((p, i) => ({ w: (CW * p) / 100, align: aligns[i] })),
        header: ['최고 심각도', '패키지', '버전', '심각도 분포'],
        rows,
        padHead: { v: s(8), h: s(8) },
        padBody: { v: s(8.5), h: s(8) },
        marginTop: 0,
        marginBottom: s(12)
    });
}

/* =========================================================================
   취약점 상세 명세 (웹 VulnDetailDrawer 1:1 통일: 헤더 · 헤드라인 · 1열 스펙 표 · 설명 · 참고 자료)
   ========================================================================= */
function drawSpecTable(r, rows) {
    if (!rows.length) return;
    const keyW = s(104);
    const valW = CW - keyW;
    const padV = s(7.5);
    const padH = s(11);
    const lineGap = s(2.5);
    const sKey = st('M', 8.8, C.inkMeta);

    const measured = rows.map((row) => {
        const keyH = r.measure([{ ...sKey, text: row.label }], keyW - padH * 2, { lh: 1.3, wrap: 'none' });
        let valH = 0;
        let subHeights = null;
        if (row.lines) {
            subHeights = row.lines.map((lineRuns) => r.measure(lineRuns, valW - padH * 2, { lh: 1.4, wrap: 'anywhere' }));
            valH = subHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, subHeights.length - 1) * lineGap;
        } else {
            valH = r.measure(row.runs, valW - padH * 2, { lh: 1.4, wrap: row.wrap ?? 'normal' });
        }
        const h = Math.max(keyH, valH) + padV * 2;
        return { ...row, keyH, valH, subHeights, h };
    });

    const totalH = measured.reduce((acc, row) => acc + row.h, 0);
    r.ensure(totalH + s(6));
    const startY = r.y;

    let cy = startY;
    measured.forEach((row, idx) => {
        r.rect(MX, cy, keyW, row.h, C.surface);
        if (idx > 0) r.hline(MX, MX + CW, cy, C.hairline, s(0.75));
        r.vline(MX + keyW, cy, cy + row.h, C.hairline, s(0.75));

        r.text([{ ...sKey, text: row.label }], MX + padH, cy + (row.h - row.keyH) / 2, keyW - padH * 2, { lh: 1.3, wrap: 'none' });

        if (row.lines) {
            let vy = cy + (row.h - row.valH) / 2;
            row.lines.forEach((lineRuns, li) => {
                r.text(lineRuns, MX + keyW + padH, vy, valW - padH * 2, { lh: 1.4, wrap: 'anywhere' });
                vy += row.subHeights[li] + lineGap;
            });
        } else {
            r.text(row.runs, MX + keyW + padH, cy + (row.h - row.valH) / 2, valW - padH * 2, { lh: 1.4, wrap: row.wrap ?? 'normal' });
        }
        cy += row.h;
    });

    r.hline(MX, MX + CW, startY, C.line, s(0.8));
    r.hline(MX, MX + CW, startY + totalH, C.line, s(0.85));
    r.y = startY + totalH + s(16);
}

function drawMarkdown(r, blocks) {
    blocks.forEach((block, idx) => {
        if (block.type === 'h') {
            const marginTop = idx === 0 ? s(2) : s(11);
            const laid = r.layout(block.runs, CW, { lh: 1.32 });
            r.y += marginTop;
            r.ensure(laid.height + s(24));
            r.y = r.drawLines(laid, MX, r.y, CW) + s(5);
            return;
        }
        if (block.type === 'p') {
            const laid = r.layout(block.runs, CW, { lh: 1.54 });
            r.y = r.drawLines(laid, MX, r.y, CW, { paginate: true }) + s(6);
            return;
        }
        if (block.type === 'list') {
            const indent = s(17);
            block.items.forEach((runs, i) => {
                const laid = r.layout(runs, CW - indent, { lh: 1.52 });
                r.ensure(laid.lines[0]?.h ?? 0);
                const marker = block.ordered ? `${i + 1}.` : '•';
                r.text({ ...MD.p, color: C.inkMeta, text: marker }, MX, r.y, indent - s(6), { lh: 1.52, wrap: 'none', align: 'right' });
                r.y = r.drawLines(laid, MX + indent, r.y, CW - indent, { paginate: true }) + s(2.5);
            });
            r.y += s(4);
            return;
        }
        if (block.type === 'pre') {
            // 웹 IDE 코드 블록 통일 (직선형 보고서 테두리 + 상단 언어 헤더 + GitHub Light 구문 강조)
            const padV = s(8.5);
            const padH = s(12);
            const langBarH = s(20);
            const innerW = CW - padH * 2;
            const laid = r.layout(block.runs, innerW, { lh: 1.48, wrap: 'pre' });
            r.y += s(4);
            let lineIdx = 0;
            let firstChunk = true;
            while (lineIdx < laid.lines.length) {
                const headerH = firstChunk ? langBarH : 0;
                r.ensure(headerH + padV * 2 + laid.lines[lineIdx].h);
                const avail = BOTTOM - r.y - headerH - padV * 2;
                const chunk = [];
                let h = 0;
                while (lineIdx < laid.lines.length && (chunk.length === 0 || h + laid.lines[lineIdx].h <= avail)) {
                    h += laid.lines[lineIdx].h;
                    chunk.push(laid.lines[lineIdx++]);
                }
                const boxH = headerH + h + padV * 2;
                r.rect(MX, r.y, CW, boxH, C.canvas);
                if (firstChunk) {
                    r.rect(MX, r.y, CW, langBarH, C.surface);
                    r.hline(MX, MX + CW, r.y + langBarH, C.hairline, s(0.75));
                    r.text(st('M', 8, C.inkMeta, { text: block.lang }), MX + padH, r.y + s(5.5), innerW, { wrap: 'none' });
                }
                r.doc.save().lineWidth(s(0.8)).rect(MX, r.y, CW, boxH).stroke(C.line).restore();
                r.drawLines({ lines: chunk }, MX + padH, r.y + headerH + padV, innerW);
                r.y += boxH;
                firstChunk = false;
                if (lineIdx < laid.lines.length) r.newPage();
            }
            r.y += s(8);
            return;
        }
        if (block.type === 'table') {
            const colCount = Math.max(1, block.headers.length);
            r.table({
                columns: Array.from({ length: colCount }, () => ({ w: CW / colCount, align: 'left' })),
                header: block.headers.map((runs) => ({ runs, wrap: 'normal', lh: 1.2 })),
                rows: block.rows.map((row) => row.map((runs) => ({ runs, wrap: 'normal', lh: 1.4 }))),
                padHead: { v: s(6), h: s(8) },
                padBody: { v: s(5.5), h: s(8) },
                valign: 'top',
                marginTop: s(5),
                marginBottom: s(9)
            });
        }
    });
}

function drawReferencesTable(r, parsedRefs, withTopRule = false) {
    if (!parsedRefs.length) return;
    const col1W = s(90);
    const col2W = CW - col1W;
    const padV = s(7);
    const padH = s(10);
    const headH = s(24);
    const sHead = st('M', 8.8, C.inkNav);

    const linkX = MX + col1W + s(4);
    const linkW = col2W - s(4) - padH;
    const rows = parsedRefs.map((ref) => {
        const runs = [st('R', 8.8, C.inkBody, { text: ref.url, link: ref.url })];
        const h = Math.max(s(13), r.measure(runs, linkW, { lh: 1.38, wrap: 'anywhere' })) + padV * 2;
        return { source: ref.source, runs, h };
    });
    const totalH = headH + rows.reduce((a, row) => a + row.h, 0);
    const topRuleExtra = withTopRule ? s(14) : 0;
    const labelH = r.measure(st('M', 9, C.inkMeta, { text: '참고 자료' }), CW, { lh: 1.3 }) + s(7);

    if (r.y + topRuleExtra + labelH + totalH > BOTTOM && r.y > TOP + 0.5) {
        r.newPage();
        withTopRule = false;
    }
    if (withTopRule) {
        r.y += s(4);
        r.hline(MX, MX + CW, r.y, C.hairline, s(0.75));
        r.y += s(13);
    }
    r.y = r.text(st('M', 9, C.inkMeta, { text: '참고 자료' }), MX, r.y, CW, { lh: 1.3 }) + s(7);

    const startY = r.y;
    r.rect(MX, startY, CW, headH, C.surface);
    r.hline(MX, MX + CW, startY, C.line, s(0.8));
    r.hline(MX, MX + CW, startY + headH, C.line, s(0.85));

    r.text({ ...sHead, text: '구분' }, MX + padH, startY + s(6.5), col1W - padH, { wrap: 'none' });
    r.text({ ...sHead, text: '링크' }, linkX, startY + s(6.5), linkW, { wrap: 'none' });

    let cy = startY + headH;
    rows.forEach((row, idx) => {
        if (idx > 0) r.hline(MX, MX + CW, cy, C.hairline, s(0.75));
        r.text(st('M', 8.8, C.inkMeta, { text: row.source }), MX + padH, cy + padV, col1W - padH, { lh: 1.38, wrap: 'none' });
        r.text(row.runs, linkX, cy + padV, linkW, { lh: 1.38, wrap: 'anywhere' });
        cy += row.h;
    });

    r.hline(MX, MX + CW, startY + totalH, C.line, s(0.85));
    r.y = startY + totalH + s(10);
}

function drawDetails(r, vulnerabilities) {
    if (vulnerabilities.length === 0) return;

    const sId = st('B', 13, C.ink);
    const sCvss = st('R', 9.2, C.inkMeta);
    const sPos = st('R', 9.2, C.inkMeta);
    const sHeadline = st('B', 13.5, C.ink);
    const sPkg = st('B', 9.6, C.ink);
    const sVal = st('R', 9.2, C.inkBody);
    const sEco = st('R', 8.4, C.inkMeta);
    const sDotSep = st('R', 9.2, C.muted);

    vulnerabilities.forEach((vuln, index) => {
        r.newPage();

        // 1. 웹 VulnDetailDrawer 상단 헤더 1:1 (ID | 심각도 CVSS ... 현재 / 전체)
        const sevMeta = SEVERITY_META[vuln.severity] ?? SEVERITY_META.UNKNOWN;
        const sSev = st('B', 9.6, sevMeta.color);
        const posText = `${index + 1} / ${vulnerabilities.length}`;
        const posW = r.width(posText, sPos);
        const headTop = r.y;
        const idW = r.width(vuln.id, sId);
        const idH = sId.size * 1.3;

        r.text({ ...sId, text: vuln.id }, MX, headTop, CW - posW - s(100), { lh: 1.3, wrap: 'none' });

        // ID와 심각도 사이 세로 구분선 (웹 .cf-drawer-head-sep)
        const sepX = MX + idW + s(10);
        const sepH = s(10.5);
        r.vline(sepX, headTop + (idH - sepH) / 2, headTop + (idH + sepH) / 2, C.line, s(0.9));

        const sevRuns = [
            { ...sSev, text: sevMeta.label },
            ...(vuln.cvssScore != null ? [{ gap: s(5) }, { ...sCvss, text: Number(vuln.cvssScore).toFixed(1) }] : [])
        ];
        const sevH = sSev.size * 1.3;
        r.text(sevRuns, sepX + s(10), headTop + (idH - sevH) / 2 + s(0.4), CW - (sepX - MX) - posW - s(24), { lh: 1.3, wrap: 'none' });

        const posH = sPos.size * 1.3;
        r.text({ ...sPos, text: posText }, MX, headTop + (idH - posH) / 2 + s(0.4), CW, { lh: 1.3, wrap: 'none', align: 'right' });

        r.y = headTop + idH + s(8);
        r.hline(MX, MX + CW, r.y, C.line, s(0.85));
        r.y += s(14);

        // 2. 헤드라인 (웹 VulnDetailDrawer.tsx 동일 로직: 제목 우선, 짧은 평문 설명 승격)
        const rawTitle = String(vuln.title || '').trim();
        const rawDesc = String(vuln.description || '').trim();
        const isShortPlainDesc =
            !rawTitle &&
            rawDesc.length > 0 &&
            rawDesc.length <= 240 &&
            !/[\r\n]/.test(rawDesc) &&
            !/[`#*]/.test(rawDesc);
        const headline = rawTitle || (isShortPlainDesc ? rawDesc : '');
        const bodyDescSource = isShortPlainDesc ? '' : rawDesc;

        if (headline) {
            const laid = r.layout([{ ...sHeadline, text: headline }], CW, { lh: 1.42 });
            r.y = r.drawLines(laid, MX, r.y, CW) + s(12);
        }

        // 3. 웹 1열 스펙 표 (패키지 · 버전 · 언어 · 의존성 파일 · CWE 분류 · 공개일 · 탐지)
        const recommended = pickRecommendedFixes(vuln.fixedVersions, vuln.package.version);
        const fixList = recommended.length
            ? recommended
            : (vuln.fixedVersions?.length ? [`${vuln.fixedVersions[0]} 이상`] : []);

        const specRows = [
            { label: '패키지', runs: [{ ...sPkg, text: vuln.package.name }], wrap: 'anywhere' },
            { label: '버전', runs: buildVersionInlineRuns(vuln.package.version, fixList[0] ?? '', fixList.slice(1)), wrap: 'normal' }
        ];

        const rawEco = String(vuln.package?.ecosystem || '').trim();
        if (rawEco) {
            const lang = resolveLanguage(rawEco);
            const showEco = rawEco.toLowerCase() !== lang.label.toLowerCase();
            specRows.push({
                label: '언어',
                runs: [
                    { dot: lang.color, r: s(2.6), size: sVal.size },
                    { ...sVal, text: lang.label },
                    ...(showEco ? [{ gap: s(5) }, { ...sEco, text: rawEco }] : [])
                ],
                wrap: 'normal'
            });
        }

        const cleanedFiles = cleanFileList(vuln.files);
        if (cleanedFiles.length > 0) {
            specRows.push({
                label: '의존성 파일',
                lines: cleanedFiles.map((file) => [{ ...sVal, text: file }])
            });
        }

        if (vuln.cwes?.length > 0) {
            const cweRuns = [];
            vuln.cwes.forEach((cwe, ci) => {
                const info = formatCweDisplay(cwe);
                if (ci > 0) cweRuns.push({ ...sDotSep, text: '  ·  ' });
                cweRuns.push(info.href ? { ...sVal, text: info.text, link: info.href } : { ...sVal, text: info.text });
            });
            specRows.push({ label: 'CWE 분류', runs: cweRuns, wrap: 'normal' });
        }

        if (vuln.publishedAt) {
            specRows.push({
                label: '공개일',
                runs: [{ ...sVal, text: String(vuln.publishedAt).slice(0, 10) }],
                wrap: 'none'
            });
        }

        const detectedList = Array.isArray(vuln.detectedBy) && vuln.detectedBy.length > 0
            ? vuln.detectedBy
            : Object.keys(vuln.sources ?? {});
        const scannerRuns = detectedList.flatMap((tool, ti, arr) => [
            ...(TOOL_COLORS[tool] ? [{ dot: TOOL_COLORS[tool], r: s(2.6), size: sVal.size }] : []),
            { ...sVal, text: TOOL_LABELS[tool] ?? tool },
            ...(ti < arr.length - 1 ? [{ gap: s(12) }] : [])
        ]);
        specRows.push({
            label: '탐지',
            runs: scannerRuns.length ? scannerRuns : [{ ...st('R', 9.2, C.inkMeta), text: '-' }],
            wrap: 'normal'
        });

        drawSpecTable(r, specRows);

        // 4. 설명 (마크다운)
        let hasDescSection = false;
        if (bodyDescSource) {
            const blocks = parseMarkdown(bodyDescSource, headline);
            if (blocks.length > 0) {
                hasDescSection = true;
                r.y = r.text(st('M', 9, C.inkMeta, { text: '설명' }), MX, r.y, CW, { lh: 1.3 }) + s(6);
                drawMarkdown(r, blocks);
                r.y += s(6);
            }
        }

        // 5. 참고 자료 (구분 | 링크 표)
        const parsedRefs = dedupeAndParseReferences(vuln.references, MAX_REFERENCES);
        if (parsedRefs.length > 0) {
            drawReferencesTable(r, parsedRefs, hasDescSection);
        }
    });
}

/* =========================================================================
   페이지 하단 (전체 페이지): 좌측 보고서명 / 우측 "현재 / 전체" 페이지
   ========================================================================= */
function drawPageFooters(r) {
    const { doc } = r;
    const range = doc.bufferedPageRange();
    const totalPages = range.count;
    const left = st('R', 8.5, C.muted);
    const right = st('M', 8.8, C.inkMeta);
    for (let i = range.start; i < range.start + totalPages; i++) {
        doc.switchToPage(i);
        const lineY = BOTTOM + s(3);
        r.hline(MX, MX + CW, lineY, C.hairline, s(0.75));
        const y = lineY + s(6.5);
        r.text({ ...left, text: 'AutoSCA' }, MX, y, CW, { wrap: 'none' });
        r.text({ ...right, text: `${i + 1} / ${totalPages}` }, MX, y, CW, { wrap: 'none', align: 'right' });
    }
}

/* =========================================================================
   진입점: normalizeResult JSON -> AutoSCA Kumo PDF 보고서 파일
   ========================================================================= */
export async function createPdf(normalizedJsonPath, savePath, target) {
    try {
        const data = JSON.parse(await fsp.readFile(normalizedJsonPath, 'utf-8'));
        if (!Array.isArray(data?.vulnerabilities)) {
            throw new Error('정리된 결과(normalizeResult) 형식의 JSON 이 아닙니다.');
        }

        const pdfPath = path.resolve(savePath);
        await fsp.mkdir(path.dirname(pdfPath), { recursive: true });
        await fsp.rm(pdfPath, { force: true });

        const targetSource = target ?? data.target?.source ?? null;
        const targetName = formatTargetName(targetSource);
        const generatedAt = new Date(data.generatedAt).toLocaleString('ko-KR', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });

        const [fonts, avatarBuf] = await Promise.all([
            loadFonts(),
            fetchRepoAvatar(targetSource)
        ]);
        const doc = new PDFDocument({
            size: 'A4',
            margin: 0,
            bufferPages: true,
            info: {
                Title: `오픈소스 취약점 점검 보고서 - ${targetName}`,
                Creator: SOLUTION_NAME
            }
        });
        for (const [key, buffer] of Object.entries(fonts)) doc.registerFont(key, buffer);

        const out = fs.createWriteStream(pdfPath);
        const finished = new Promise((resolve, reject) => {
            out.on('finish', resolve);
            out.on('error', reject);
            doc.on('error', reject);
        });
        doc.pipe(out);

        const r = new Renderer(doc);
        drawCover(r, data, targetSource, generatedAt, avatarBuf);
        drawPackagePriority(r, data.vulnerabilities);
        drawDetails(r, data.vulnerabilities);
        drawPageFooters(r);

        doc.end();
        await finished;

        const stat = await fsp.stat(pdfPath).catch(() => null);
        if (!stat || stat.size === 0) throw new Error('PDF 파일이 생성되지 않았습니다.');

        return {
            result: true,
            data: pdfPath
        };
    }
    catch (error) {
        return {
            result: false,
            data: error.message
        };
    }
}
