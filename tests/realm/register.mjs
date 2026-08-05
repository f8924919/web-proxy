// `node --import ./tests/realm/register.mjs` でフックを登録する（テスト方針 §1.2）。
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
