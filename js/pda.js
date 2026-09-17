import { selectPdaModule } from './modeRouter.js?v=20260917a';

const moduleName = selectPdaModule(window.location.search);
await import(`./${moduleName}?v=20260917a`);
