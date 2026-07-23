# 참고자료: 동아시아 전통건축 도면·3D 모델·비례 문헌

최초 조사일: 2026-07-16. #81 야간 창호 자료 추가 확인: 2026-07-23. 각 항목의 "검증" 표기는 조사 시점에
실제 원문 페이지 접속과 내용 확인 여부다.

- [x] 한국 (조사 완료)
- [x] 일본 (조사 완료)
- [x] 중국 (조사 완료)

도구·라이브러리 스택 조사는 `docs/tooling.md` 참고.
조선 진경산수의 미학 원칙과 제품 수묵 렌더로의 번역은 [`ink-landscape.md`](ink-landscape.md)를 기준으로 한다.

---

# 한국 (조선 목조건축)

국가유산청 도메인은 개편으로 heritage.go.kr / khs.go.kr / cha.go.kr가 혼용되고 있으니 접속 실패 시 상호 대체해서 시도할 것.

## 1. 실측도면 / 수리보고서 (최우선)

### 1-1. 국가유산 디지털 서비스 — 원형 데이터 (실측조사보고서·도판 PDF)
- URL: https://digital.khs.go.kr/ (원형 데이터 메뉴). 개별 예시: 영주 부석사 실측조사보고서(도판) → https://digital.khs.go.kr/buis/buisDetail.do?bizUid=13898748261677900003&ctptNo=1113700180000&ctptUid=13898859665883200019
- 내용: 문화재청/국가유산청이 발주한 실측조사보고서·수리보고서 원문을 건물별로 PDF 제공. 부석사 무량수전(국보)의 경우 2002년 실측조사보고서 도판 PDF가 실제로 열람·다운로드됨. 도면 도판이 포함되어 파라메트릭 비례 추출에 가장 유용.
- 포맷: PDF
- 라이선스·접근: 로그인 불필요, 무료 다운로드 (원형데이터 기록보존 사업 결과물)
- 검증: 접속 확인 (부석사 도판 PDF 다운로드 가능 확인)
- 검색 방법: digital.khs.go.kr → "원형 데이터" → 건물명(예: 근정전, 무량수전, 극락전) 검색. 대표 건물 다수가 실측/수리 보고서 형태로 등재.

### 1-2. 국가유산포털 — 간행물(수리보고서 eBook)
- URL: https://www.heritage.go.kr/ → 간행물. 개별 예시(창경궁 명정전 창호 보수공사 수리보고서, 2024): https://www.heritage.go.kr/heri/cul/linkSelectEbookDetail.do?bbsId=BBSMSTR_1021&nttId=88771
- 내용: 궁궐·문화재 수리·보수공사 수리보고서를 eBook/PDF로 제공.
- 포맷: PDF (전자책 뷰어 + 다운로드)
- 라이선스·접근: 로그인 불필요. **주의: 해당 보고서는 공공누리 제4유형(출처표시+상업적이용금지+변경금지)** — 자료별로 유형이 다르므로 개별 확인 필요.
- 검증: 접속 확인

### 1-3. 문화유산연구지식포털(국가유산 지식이음) — 수리공사별 목록
- URL: https://portal.nrich.go.kr/ (통합검색: https://portal.nrich.go.kr/kor/search/totalSearch.do). 예시(신륵사 극락보전 완전해체수리): https://portal.nrich.go.kr/mobile/inventoryUsrView.do?menuIdx=597&m_number=211
- 내용: 문화재 수리공사 이력과 수리실측보고서 서지 정보. 보고서 원문 PDF는 1-1로 연결되는 경우가 많음.
- 포맷: 웹(HTML) 중심
- 라이선스·접근: 로그인 불필요, 공공누리 제1유형(출처표시)
- 검증: 접속 확인. 직접 PDF 다운로드 버튼은 없음 — 원문 확보는 1-1 우선.

> 대표 건물별: 부석사 무량수전 실측보고서 PDF는 1-1에서 확인됨. 근정전/숭례문/봉정사 극락전도 같은 경로에서 건물명 검색으로 접근 가능(개별 파일 존재 여부는 검색 시점 확인 필요).

## 2. 3D 스캔 / 모델 데이터

### 2-1. 국가유산 디지털 서비스 — 3D 에셋 서비스 (최우선 추천)
- URL: https://digital.khs.go.kr/heritage/heriTage.do
- 내용: 6개 테마(조선시대 궁궐문화, 생활문화, 자연유산 문화경관, 천년 신라 왕경, 조선시대 정치국방, 해양유산 전통선박)로 국가유산 3D 에셋을 무료 개방. Sketchfab / Unreal Engine / Unity 등 플랫폼 연계 제공. 게임·영화·시뮬레이션 제작에 무료 사용 명시.
- 포맷: 페이지에 명시 없음 — Sketchfab 경유 시 glTF/GLB 가능성. 개별 에셋에서 확인 필요.
- 라이선스·접근: 로그인 없이 조회, 무료 사용 표방. 구체적 라이선스 문구는 개별 에셋에서 확인 권장.
- 검증: 접속 확인 (포맷은 미확정)

### 2-2. 공공데이터포털 — 국가유산 3D 원형 정보자원 목록
- URL: https://www.data.go.kr/data/15147467/fileData.do
- 내용: 3D 원형 자원의 메타데이터 카탈로그(어떤 3D 자원이 있는지 인덱스). 지오메트리 아님.
- 포맷: CSV(직접 다운로드), XML/JSON(Open API)
- 라이선스·접근: 공공누리 제1유형. CSV는 로그인 불필요, API는 회원가입+활용신청.
- 검증: 접속 확인

### 2-3. 공공데이터포털 — 국가유산 3D 프린팅 데이터
- URL: https://www.data.go.kr/data/15028100/fileData.do
- 내용: 3D 스캔 기반 프린팅용 데이터 약 1천여 건 무료 개방.
- 포맷: PLY, STL (Three.js 직접 로드 또는 glTF 변환 가능)
- 라이선스·접근: 공공누리 기반 무료, 파일 다운로드형
- 검증: 미접속(검색 기반) — 재확인 권장

### 2-4. 공공데이터포털 — 석탑 원형기록화 3D데이터 (Open API)
- URL: https://www.data.go.kr/data/15015634/openapi.do
- 내용: 석탑 정밀 3D 기록화 API (목조 아님, 석조 부재 기하 참고용)
- 라이선스·접근: 활용신청 필요
- 검증: 미접속(검색 기반)

### 2-5. Sketchfab — 한국 전통건축 모델
- 태그: https://sketchfab.com/tags/korean-traditional , https://sketchfab.com/tags/korea
- 개별 예시:
  - 경복궁 근정전 (TRIPLE): https://sketchfab.com/3d-models/korea-gyeongbokgung-geunjeongjeonjoseon-palace-c17d8eefb58f4bcfb8c6e71ac6fbe3fc — **유료**(Store, Royalty Free). 삼각형 약 210만, 4K 텍스처. 검증: 접속 확인.
  - Korean Traditional Architecture Module (GamzaStock): https://sketchfab.com/3d-models/korean-traditional-architecture-module-2efb12603df34a3bbe7782fbb64cc800 — 약 69.6만 삼각형. 검증: 접속 확인(다운로드 가능 여부·라이선스 미확인).
  - 무료 파빌리온: https://sketchfab.com/3d-models/paviliontraditional-korean-architecture-37cfc1f927a147bfb191573767a8a1b9
- 포맷: 다운로드 가능 모델은 통상 glTF/GLB + 원본 포맷
- 라이선스·접근: 모델마다 상이(CC-BY/CC0/유료) — 개별 확인 필수. 다운로드에 무료 계정 로그인 필요.
- 참고: 국립중앙박물관/국립고궁박물관의 공식 Sketchfab 계정은 확인되지 않음 — 건축물 3D 공식 배포 창구는 사실상 2-1.

### 2-6. Open Heritage 3D — 한국 데이터 없음 (제외)
- URL: https://openheritage3d.org/data
- 검증: 접속 확인 — 한국 문화유산 데이터셋 없음. 한국 목조건축 용도로는 부적합.

### 2-7. V-World — 제약 커서 제외
- URL: https://www.vworld.kr/
- 3D 데이터 Open API 폐쇄, 3차원 데이터가 "공개제한" 분류로 재배포 제약 큼. 지형/배경 컨텍스트 용도로만 제한적 참고.
- 검증: 미접속(검색 기반)

## 3. 비례·구조 해설 자료

### 3-1. 논문: 전통건축 지붕곡 구조분석을 통한 지붕가구부 설계도구의 구현 (최우선 추천)
- URL: https://www.koreascience.kr/article/JAKO201411560020565.pub?lang=ko (PDF: /article/JAKO201411560020565.pdf)
- 저자/출처: 이현민·안은영(한밭대), 한국멀티미디어학회논문지 17(3), 2014, pp.393–404
- 내용: **지붕곡(앙곡·안허리곡)을 전산학적으로 분석해 3D로 설계하는 방안.** 추녀·서까래 등 부재 간 기하 상관관계를 함수식으로 정의, 속성 변경 시 자동 재설계되는 설계도구 구현. 절차적 지붕 생성 로직에 직접 응용 가능한 핵심 자료.
- 포맷: HTML 전문 + PDF
- 라이선스·접근: 무료 PDF, 로그인 불필요
- 검증: 접속 확인

### 3-2. 국가한옥센터(AURI) 한옥DB — 한옥이론
- URL: https://www.hanokdb.kr/theology/sub_04 (시공), https://www.hanokdb.kr/theology/sub_03 (감상), https://www.hanokdb.kr/theology/sub_01 (가치), https://www.hanokdb.kr/theology/sub_02 (종류)
- 내용: 공포(주심포/다포/익공), 지붕(추녀·서까래·기와잇기), 칸, 창호, 천장 등 목조 구조 요소를 이미지
  도해와 함께 해설. 시공 편은 살문 뒤의 창호지를, 감상 편은 창호지를 실내 쪽에 붙여 외부에서 살 무늬가
  읽히는 관계를 설명한다. #81은 이를 실제 고정 한지 plane anchor의 근거로 쓰며, 주간 채광 설명을 야간 외부
  휘도·색·점등 빈도 근거로 확대하지 않는다.
- 포맷: 웹(HTML) + 도해
- 라이선스·접근: 무료, 로그인 불필요
- 검증: 접속 확인
- 추가: 국가한옥센터 "한옥 건축 사례집" PDF — https://www.auri.re.kr/pdf/Hanok%20Examples%204.pdf (검증: 미접속)

### 3-3. 서울한옥포털 — 한옥의 구조
- URL: https://hanok.seoul.go.kr/front/kor/info/infoHanok.do?tab=2
- 내용: 한옥 구조(공포·도리·보 등) 입문 해설. 3-2와 상호보완.
- 검증: 미접속(검색 기반)

### 3-4. 학술 DB 논문 (공포 비례·영조규범)
- 한국 전통 목조건축의 영조 규범에 관한 연구 — 공포의 구조적 역할 중심 (대한건축학회논문집, DBpia): https://www.dbpia.co.kr/journal/articleDetail?nodeId=NODE00358816 — 주심포계 18동·다포계 23동의 공포 양식별 비례수치 분석. 비례 파라미터 설정에 직접 유용.
- 출목익공 기원과 변천에 관한 연구 (DBpia): https://www.dbpia.co.kr/journal/articleDetail?nodeId=NODE00360344
- 한국목조건축에 나타나는 하앙의 영향 (ScienceON/KISTI): https://scienceon.kisti.re.kr/srch/selectPORSrchArticle.do?cn=DIKO0008469900
- 라이선스·접근: DBpia는 유료/기관 구독. ScienceON/KCI는 논문별 상이. 무료 확실한 것은 3-1.
- 검증: 미접속(서지·초록 수준)

### 3-5. 국립민속박물관 — 「빛으로 밝히고 조명으로 통하다」
- URL: https://webzine.nfm.go.kr/2018/09/06/%EB%B9%9B%EC%9C%BC%EB%A1%9C-%EB%B0%9D%ED%9E%88%EA%B3%A0-%EC%A1%B0%EB%AA%85%EC%9C%BC%EB%A1%9C-%ED%86%B5%ED%95%98%EB%8B%A4/
- 내용: 양초·호롱·석유등 같은 조명 도구와 생활의 변화를 소개하는 국립민속박물관 전시 해설.
- 적용과 한계: 작은 연소 점광원이라는 역사 어휘만 #81의 입력으로 삼는다. 일부 거주 창호를 따뜻하고 낮은
  에너지로 켜고 다른 방은 어둡게 남기는 분포, 정확한 색·밝기·flicker·점등 비율은 성능·미학을 위한 제품
  번역이지 원문에서 측정한 값이 아니다. 실제 한지 면 anchor와 depth 가림은 AURI의 창호 구성 및 렌더 공간
  계약에서 따로 도출한다.
- 포맷: 웹(HTML), 로그인 불필요
- 라이선스·접근: 공개 웹진의 링크와 사실 요약만 사용. 원문·사진은 재배포하지 않으며 최신 기관 이용조건은
  자산 재사용 전에 다시 확인.
- 검증: 2026-07-23 원문 페이지 접속·내용 확인

### 3-6. 국가유산청·국립문화유산연구원·한국학중앙연구원 — 사찰 전각 역할과 형식 위계
- URL:
  - 국립문화유산연구원 「가람배치」: https://portal.nrich.go.kr/kor/archeologyUsrView.do?idx=10011&menuIdx=792
  - 한국민족문화대백과사전 「절」: https://encykorea.aks.ac.kr/Article/E0049782
  - 한국민족문화대백과사전 「보제루」: https://encykorea.aks.ac.kr/Article/E0023528
  - 국가유산포털 「칠곡 송림사 대웅전」: https://www.heritage.go.kr/heri/cul/culGuidePostDetail.do?ccbaCpno=1123721310000&ccgbGbtype=IND&ccgbGbtypeNo=1&pageNo=1_5_0_0
  - 국가유산포털 「영주 부석사 안양루」: https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaAsno=0021830000000&ccbaCpno=1123721830000&ccbaCtcd=37&ccbaKdcd=12&pageNo=1_1_1_0
  - 국가유산포털 「영주 부석사 범종각」: https://heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=1123721840000
- 확인한 사실: 가람은 금당·문·강당·경루·종루·승방의 규모·거리·위치가 구분되는 공간 체계이고, 불전은
  본존을 봉안하는 중심 건물, 강당은 설법·법요, 승방/주고는 수행·거주·살림, 산문·종각은 진입과 의식
  법구의 별도 역할을 맡는다. 보제루는 중심 불전 앞에서 강당 기능과 진입 기능을 겸할 수 있다. 실제 중심
  불전도 송림사 대웅전의 5×3칸 다포 겹처마 맞배와 부석사 무량수전의 주심포 팔작처럼 하나의 지붕/공포
  형식으로 고정되지 않는다.
- 적용: `src/temple/role-hierarchy.js`의 주불전 4 → 부불전 3 → 강당/누각 2 → 요사/선방 1 상대 위계,
  seed-stable 맞배/주심포·팔작/다포 repertoire, 낮아지는 기둥·기단·처마·공포 밀도와 같은 plan-owned
  `roofGrammar`/`bracketGrammar`/`eaveGrammar`로 번역한다. 실제 처마 polygon이 경계·충돌·남측 일조와
  renderer의 공통 입력이다.
- 한계: 기관 자료는 역할 구분과 사례별 형식을 확인하지만, 전국 사찰의 보편 높이·처마 깊이·공포 밀도
  통계나 이 앱의 1–4 수치 간격을 제공하지 않는다. 수치는 근경 식별성과 성능을 위한 절제된 제품 결정이고,
  어느 한 문화유산의 실측 복원이 아니다. 궁궐 전용 잡상·취두는 추가하지 않는다.
- 포맷: 기관 웹 해설(HTML), 로그인 불필요. 원문 이미지·도면은 저장소나 Product References에 재배포하지 않음.
- 라이선스·접근: 국립문화유산연구원 해당 항목은 **공공누리 제4유형**, 한국민족문화대백과는 항목별
  공공누리 표시와 출처표시 조건, 국가유산포털은 국가유산청 이용조건을 따른다. 앱은 링크와 사실·제품
  해석의 요약만 제공하며 별도 자산 재사용 전에 최신 조건을 재확인한다.
- 검증: 2026-07-23 각 canonical 페이지의 본문·기관·이용조건 표기와 최종 도착지 확인.

## 한국 자료 요약 및 우선순위

- **도면/비례 실측**: 1-1 (국가유산 디지털 서비스 원형데이터 PDF) 최우선 — 무료·검증 완료, 부석사 무량수전 도판 PDF 확보 가능.
- **3D 에셋**: 2-1 (디지털 서비스 3D 에셋) + 2-3 (PLY/STL) 조합. 부족 시 Sketchfab(2-5) 개별 라이선스 확인 후 보완.
- **절차적 생성 로직**: 3-1 (지붕곡 함수식 논문)이 앙곡·안허리곡 파라메트릭 구현에 직결.
- **제외**: Open Heritage 3D(한국 데이터 없음), V-World(공개제한).
- **라이선스 주의**: 공공누리 4유형(상업·변경 금지) 자료가 섞여 있음 — 데모 공개 배포 시 자료별 유형 확인 필수.

---

# 일본 (사찰·신사 목조건축)

검증 표기: **[Fetch검증]** = 실제 접속·내용 확인 / **[검색검증]** = 검색으로 존재·조건 확인 (직접 접속은 서버 429 등으로 미완) / **[참고]** = 배경자료.

## 1. 고전 비례 문헌 (木割書 / 匠明)

**핵심 결론**: 『匠明』(쇼메이) 원본 필사본은 東京大学 소장이며 무료 스캔은 온라인 미공개. 무료로 바로 볼 수 있는 것은 (a) 匠明 분석 학술논문 전문 PDF, (b) NDL 디지털화 1971년 복간본(로그인 필요).

### 1-1. 논문: 「匠明・社記集」の成立過程について (1996)
- URL: https://www.jstage.jst.go.jp/article/aija/61/487/61_KJ00004221757/_article/-char/ja/
- 내용: 匠明 5권 중 社記集(신사편)의 성립 과정과 木割 치수 산정 기술 분석. 목할 비례 체계 이해에 직접 유용.
- 포맷: PDF 전문 / 라이선스·접근: J-STAGE 오픈액세스, 무료·로그인 불필요
- 검증: [Fetch검증]

### 1-2. 匠明 복간본 (太田博太郎 감수, 鹿島研究所出版会 1971) — NDL 디지털화본
- URL(서지): https://ndlsearch.ndl.go.jp/books/R100000002-I000001277551
- 내용: 匠明 5권(門記集·社記集·堂記集·塔記集·殿屋集)의 교정·해설 복간본. 목할서의 표준 참조본.
- 접근: **주의 — 비로그인 열람 불가.** 저작권 보호 중이라 NDL 「個人向けデジタル化資料送信サービス」(무료 회원가입+로그인) 또는 제휴 도서관에서만 열람.
- 검증: [Fetch검증] (서지 페이지)

### 1-3. 匠明 개요 — Wikipedia (일본어)
- URL: https://ja.wikipedia.org/wiki/匠明
- 내용: 平内政信(1608년 발문) 성립, 5권 구성, 필사본 소장처 등 개요. CC BY-SA.
- 검증: [참고]

## 2. 도면 / 수리공사보고서 (修理工事報告書·実測図)

**핵심 플랫폼**: **全国遺跡報告総覧**(奈良文化財研究所, sitereports.nabunken.go.jp). "修理・整備" 카테고리 244건 중 88건이 PDF 전문 제공, 다운로드 로그인 불필요(플랫폼 정책). 조사 시점 개별 페이지 직접 접속이 429로 막혀 개별 PDF 유무는 재확인 필요.

### 2-1. 國寳法隆寺五重塔修理工事報告 附圖 (실측도면집)
- URL: https://sitereports.nabunken.go.jp/en/134222 (일본어판 /ja/134222)
- 내용: 법륭사 오중탑 쇼와 해체수리(1955) 보고서의 부도(附圖) = 실측도면. **지붕 곡선·組物 치수 파악에 최적.**
- 포맷: PDF (스캔 도면) / 접근: 무료·로그인 불필요(플랫폼 정책)
- 검증: [검색검증] (직접 접속 429)

### 2-2. 国宝東大寺金堂(大仏殿)修理工事報告書
- URL: https://sitereports.nabunken.go.jp/en/136856
- 내용: 동대사 대불전 쇼와 대수리(1980). 본문·도면·사진 3분책, 실측도면 포함.
- 검증: [검색검증]

### 2-3. 東大寺境内地実測平面図
- URL: https://sitereports.nabunken.go.jp/en/137066 — 동대사 경내 실측 평면도. [검색검증]

### 2-4. 文化遺産オンライン — 문화재 데이터베이스
- URL: https://online.bunka.go.jp/ (구 bunka.nii.ac.jp는 여기로 리다이렉트). 건조물 검색: https://bunka.nii.ac.jp/heritages/search/from:menu/classification_1:1/classification_2:1/genre_1:1
- 예시: 法隆寺東院伝法堂 https://online.bunka.go.jp/db/heritages/detail/123504 — 구조 표기("桁行七間、梁間四間、一重、切妻造、本瓦葺") 등 제원 수록
- 내용: 국보·중요문화재 건조물의 지정정보·구조 양식(간수·지붕형식). 도면보다는 **제원·형식 데이터** 확보에 유용.
- 접근: 무료·로그인 불필요 / 검증: [Fetch검증]

### 2-5. 기타
- 国指定文化財等データベース: https://kunishitei.bunka.go.jp/ — 지정문화재 통합 검색. [참고]
- e国宝: https://emuseum.nich.go.jp/ — 고해상 이미지(한국어 지원)이나 동산 문화재 위주라 건축 자료는 제한적. [검색검증]

## 3. 3D 모델

### 3-1. Sketchfab — japanese-temple 태그
- URL: https://sketchfab.com/tags/japanese-temple
- 대표: Japanese Hōryū-ji Temple (Replica) https://sketchfab.com/3d-models/japanese-horyu-ji-temple-replica-a764899f1e7c45e6a2a3d8911ab436d3 — **CC-BY, 무료 다운로드** (다운로드 2,517회)
- 검증: [Fetch검증] (법륭사 모델)

### 3-2. 奈良文化財研究所 공식 Sketchfab (@nabunken)
- URL: https://sketchfab.com/nabunken
- 내용: 東大寺式軒瓦(처마기와)·礎石(초석) 등 건축 부재/유구 3D 모델. **CC BY 4.0**, 다운로드는 Sketchfab 로그인 필요.
- 검증: [검색검증]

### 3-3. 全国文化財情報デジタルツインプラットフォーム / 3D DB Viewer (奈文研)
- URL: https://sitereports.nabunken.go.jp/3ddb
- 내용: 건조물 CAD 모델·점군 등 3D 데이터 통합 열람. 실측 기반 형상 확보 가능.
- 검증: [검색검증]

### 3-4. 기타
- 東京文化財研究所 Sketchfab (@tobunken): https://sketchfab.com/tobunken — 해외 유적 위주, 일본 사찰 직접자료 아님. [Fetch검증]
- ColBase: https://colbase.nich.go.jp/ — 2D 이미지 위주, 3D 아님. [참고]

## 4. 구조 해설 (反り 지붕 곡선 / 組物 도해)

### 4-1. 反り屋根の形 (일본OR학회 회지 30권 10호)
- URL: https://orsj.org/wp-content/or-archives50/pdf/bul/Vol.30_10_637.pdf
- 내용: **일본 반곡 지붕(反り)의 형태를 수리적/기하학적으로 다룬 리포트. 지붕 곡선 파라메트릭 정의에 직접 참고.**
- 포맷: PDF(스캔형, 약 693KB) / 접근: 무료·로그인 불필요
- 검증: [Fetch검증] (PDF 다운로드 확인)

### 4-2. 古代建築における三手先組物について (奈文研 기요, 1997)
- URL: https://repository.nabunken.go.jp/dspace/bitstream/11177/2960/1/AN00181387_1997_%E2%85%A0_20_21.pdf
- 내용: **三手先(삼수선) 組物의 구조·치수 도해. 구미모노 파라메트릭 재현에 핵심.**
- 포맷: PDF(스캔형, 약 919KB) / 접근: 무료·로그인 불필요
- 검증: [Fetch검증] (PDF 다운로드 확인)

### 4-3. 기타
- 組物 (Wikipedia 일본어): https://ja.wikipedia.org/wiki/組物 — 斗·肘木·三手先·出組·二手先 유형 도해. [참고]
- J-STAGE 日本建築学会 논문집: https://www.jstage.jst.go.jp/browse/aija/-char/ja/ (計画系), /browse/aijs/ (構造系) — 전통 목조 지붕 가구·組物 논문 다수, 오픈액세스 혼재. [검색검증]
- 보조 해설 웹(비학술): カナメ 豆知識 https://www.caname-jisha.jp/cms/?p=1228 , AONIYOSHI 組物 해설 https://eich516.com/word_kumimono [참고]

## 일본 자료 요약

- **지붕 곡선 수학**: 4-1 (反り屋根の形 PDF) — 무료 검증 완료.
- **組物 구조**: 4-2 (三手先 도해 PDF) — 무료 검증 완료.
- **실측도면**: 2-1 법륭사 오중탑 附圖가 최우선 타깃 (全国遺跡報告総覧, 재접속 필요).
- **3D 모델**: 법륭사 CC-BY 모델(검증 완료) + 奈文研 공식 부재 모델.
- **접근 제약**: 匠明 복간본은 NDL 무료 가입 필요. sitereports는 429 발생 시 시간 두고 재시도.

---

# 중국 (목조 궁전·사찰)

## 1. 고전 비례 문헌 (최우선)

### 1-1. 『營造法式』 전문 — 中國哲學書電子化計劃 (ctext.org)
- URL: https://ctext.org/wiki.pl?if=en&res=819803
- 내용: 북송 이계(李誡, 1103년) 편찬 관영 건축 표준서 전 34권 + 서문. **재분(材分) 모듈 시스템, 대목작(大木作)·소목작·두공·기와·채화 규정.** 송대 판본 두공·앙(昂) 도판 4점 갤러리 수록.
- 포맷: 웹 텍스트(HTML, OCR 기반 — 오탈자 가능성, 도판은 archive.org/위키미디어와 대조 권장)
- 라이선스·접근: 무료, 로그인 불필요
- 검증: 접속 확인 (34권 목차·도판 존재)

### 1-2. 『營造法式』 스캔 원본 — Internet Archive
- URL: https://archive.org/details/06051724.cn (권30~32; 전체는 8책 분책 — "營造法式" 검색으로 나머지 확인)
- 내용: 저장대학 도서관 600dpi 스캔 원본.
- 포맷: PDF(6.0M), EPUB, TIFF, OCR(간체)
- 라이선스·접근: 무료, 로그인 불필요, 다운로드 가능
- 검증: 접속 확인

### 1-3. Yingzao Fashi 해설 — Wikipedia (영문)
- URL: https://en.wikipedia.org/wiki/Yingzao_Fashi
- 내용: **재분(cai-fen) 8등급 材 시스템** 등 비례 규칙 요약, 34권 구성, 두공 규정. 파라메트릭 재현의 진입점으로 최적.
- 라이선스: CC BY-SA / 검증: 접속 확인

### 1-4. 梁思成 『A Pictorial History of Chinese Architecture』 (MIT Press 1984)
- URL(서지): https://catalog.hathitrust.org/Record/012256822
- 내용: 240여 점 사진·도면으로 구조 체계·두공 유형 변천 분석한 표준 영어 참고서.
- 접근: **저작권 보호 — 무료 전문 미확보.** 서지·부분열람만 가능. (Scribd 업로드본은 저작권 불명확하여 제외)
- 검증: 부분 확인

### 1-5. 보조: 1925년판 영조법식 도판 분석 논문 (Chiu et al., JAABE 2019)
- URL: https://publications.bilkent.edu.tr/pdf/files/14598.pdf
- 내용: 1925년판 영조법식 도판(두공·처마) 분석, 도판 이미지 다수 수록.
- 포맷: PDF(2.3MB) / 접근: Bilkent 리포지토리 무료
- 검증: 접속 확인 (PDF 다운로드 성공)

## 2. 두공(斗栱) 구조 자료

### 2-1. 영조법식 두공 도판 원본 — Wikimedia Commons (최우선)
- URL: https://commons.wikimedia.org/wiki/File:Yingzao_Fashi_1.JPG (및 File:Yingzao_Fashi_3.JPG, File:Yingzao_Fashi_5.JPG)
- 내용: 1.JPG=대전 단면의 3조 두공 조립 도해(도리 곡률·앙 지렛대 표현), 3.JPG=앙 포함 두공 군집, 5.JPG=5종 공(栱) 밑동·앙 2종 작업도. **파라메트릭 분해 참고에 직접 활용 가능한 12세기 원 도면.**
- 포맷: JPEG 고해상 / 라이선스: **퍼블릭 도메인**, 무료 원해상도 다운로드
- 검증: 접속 확인

### 2-2. Dougong Revisited: A Parametric Specification of Chinese Bracket Design in Shape Machine (Springer 2024)
- URL: https://link.springer.com/chapter/10.1007/978-3-031-71918-9_15 (요약: https://www.researchgate.net/publication/384409581)
- 내용: **두공을 형상문법(shape grammar)으로 파라메트릭 생성하는 프레임워크** — 이 프로젝트의 두공 생성 설계에 개념적으로 가장 직접 부합.
- 접근: Springer 유료/기관. ResearchGate에 요약·그림 공개
- 검증: 부분 확인 (무료 전문 미확보)

### 2-3. Manufacture and Assembly Mechanism of Dougong (IOP Conf. 2020)
- URL: https://iopscience.iop.org/article/10.1088/1757-899X/960/2/022008/pdf
- 내용: 斗·栱·순묘(榫卯) 결합의 제작·조립 메커니즘 분해도.
- 접근: 오픈액세스(CC BY 3.0) 무료. WebFetch는 봇 차단(403) — 브라우저 접근 가능성 높음
- 검증: 미확인 (403)

### 2-4. 5출목 두공 정적 시뮬레이션 논문 (BioResources 21(2), 2026)
- URL: https://bioresources.cnr.ncsu.edu/wp-content/uploads/2026/02/BioRes_21_2_3284_Li_He_Yao_Simulation_Static_5_tier_Dougang_Bracket_Yanghe_25256.pdf
- 내용: 5출목 외첨주두 두공의 **부재별 치수·조립 구조 상세.**
- 포맷: PDF(1.8MB) / 접근: 완전 오픈액세스 무료
- 검증: 접속 확인 (다운로드 성공)

## 3. 3D 모델

### 3-1. Forbidden City model (자금성) — Sketchfab
- URL: https://sketchfab.com/3d-models/forbidden-city-model-5d300689fcae47ed980b38f680f59e02
- 내용: 자금성 간략 모델, 167.3k 삼각형.
- 라이선스: **CC BY 4.0 + "NoAI" 표기** — 생성형 AI 학습·입력용 사용 금지 (시각 참고는 무방). 다운로드에 로그인 필요 가능.
- 검증: 접속 확인

### 3-2. Traditional Chinese Siheyuan Courtyard (사합원) — Sketchfab
- URL: https://sketchfab.com/3d-models/traditional-chinese-siheyuan-courtyard-a18881525cfd4fe882e739c9c7cee752
- 내용: 사합원 상세 모델. 처마·기와·목구조 참고. CC BY(검색 기준).
- 검증: 미확인 (JS 렌더링 — 브라우저 확인 권장)

### 3-3. 태화전 지붕 모델 — Sketchfab
- URL: https://skfb.ly/oV69n (写实比例_故宫太和殿顶部)
- 내용: **자금성 태화전 지붕부 실측 비례 모델 — 유리기와 지붕·두공·처마 참고에 가장 직접적.** CC BY(검색 기준).
- 검증: 미확인 (브라우저 확인 권장)

### 3-4. 탐색 진입점
- 태그: https://sketchfab.com/tags/chinese-architecture , https://sketchfab.com/tags/forbidden-city
- 컬렉션: https://sketchfab.com/tigerofchen/collections/chinese-traditional-architecture-158e6234ff5b4a8ab4930d0956fb4493
- 비 Sketchfab: MakerWorld 태화전 https://makerworld.com/en/models/1467954 , CGTrader 무료 태화전·보화전 https://www.cgtrader.com/free-3d-models/exterior/landmark/beijing-forbidden-city-hall-of-supreme-harmony-and-preserving-harmony-house
- 개별 모델마다 라이선스·NoAI 여부 상이 — 건별 확인 필수.

## 4. 치수·도면 자료 (대표 건물)

### 4-1. 응현목탑(應縣木塔) 파라메트릭 모델링·주망 분석 — MDPI Buildings 2024 (최우선)
- URL: https://www.mdpi.com/2075-5309/14/8/2464
- 내용: **응현목탑 주망(column grid)·두공의 파라메트릭 모델링·비례 분석. 32,000여 부재 3D 모델 + 파라메트릭 파일 언급.** 수치: 전고 67.31m, 하부 직경 30.27m, 54종 두공, 층당 외주 24·내주 8 기둥.
- 접근: MDPI 오픈액세스(CC BY) 무료. WebFetch는 403 — 브라우저 접근 가능성 높음
- 검증: 미확인 (403)

### 4-2. 불광사 동대전(佛光寺 東大殿) — 양사성 1937 실측
- URL(변형 모니터링 논문): https://scispace.com/pdf/monitoring-of-deformation-of-the-foguang-temple-s-east-27m923dw53.pdf
- 내용: 857년 당대 건축. 양사성 1937년 실측 입면·단면도. scispace 논문에 실측 치수·도면 일부.
- 검증: 부분 확인
- 관련 단행본: 『Liang Sicheng and the Temple of Buddha's Light』 (ISBN 9789814441032)

### 4-3. 응현목탑 두공 시스템 도해 — ResearchGate
- URL: https://www.researchgate.net/figure/Dougong-system-constructed-on-the-Yingxian-Wooden-Pagoda-Screenshot-from-The_fig3_334682676
- 내용: 층별 두공 배치 도해. 열람 무료(다운로드는 계정 필요 가능).
- 검증: 미확인

## 중국 자료 요약

- **재분 모듈 규칙**: ctext.org 전문 + Wikipedia 해설 조합 (모두 검증 완료).
- **두공 분해 형상**: Wikimedia 원 도판(퍼블릭 도메인, 검증 완료) + BioResources 치수 논문(검증 완료).
- **치수 검증**: MDPI 응현목탑 논문 (브라우저로 재확인 필요).
- **3D 참고**: 태화전 지붕/자금성 모델 — **NoAI 표기 유의, 시각 참고용으로만.**
