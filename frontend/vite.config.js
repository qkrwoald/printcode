import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    target: 'es2022',
    // 소스맵을 배포하지 않는다 (불필요한 노출 방지)
    sourcemap: false,
    // 작은 파일(글꼴 조각 등)을 data: 주소로 CSS에 끼워 넣지 않는다.
    // CSP(default-src 'self')가 data: 글꼴을 막기 때문에, 모두 우리 서버의 별도 파일로 내보낸다.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        home: `${root}index.html`,
        upload: `${root}upload/index.html`,
        print: `${root}print/index.html`,
        printWindow: `${root}print/window/index.html`,
      },
    },
  },
  server: {
    // 개발 중에는 /api 요청을 FastAPI(8000)로 넘긴다
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
});
