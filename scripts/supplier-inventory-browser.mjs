import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApplication } from "../test/helpers/native-app.mjs";
import { getPaths } from "../test/helpers/native.mjs";
import { catalogFixture } from "../test/helpers/codex-fixture.mjs";
const home=await fs.mkdtemp(path.join(os.tmpdir(),"cabletidy-inventory-browser-"));
let app,browser;
try {
 app=await createApplication({paths:getPaths(home),loadCodexCatalog:async()=>catalogFixture()});
 let c=(await(await fetch(`${app.url}api/v1/config`)).json()).config;
 const commit=async operation=>{const r=await fetch(`${app.url}api/v1/config/commit`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:c.revision,operation})});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));c=v.config;};
 for(const sid of ["one","two"]) {
  await commit({type:"supplier.save",supplierId:sid,data:{name:`Supplier ${sid}`,interfaces:{responses:{protocol:"openai.responses",baseUrl:"https://example.invalid/v1",secret:"browser-key"}}}});
  await commit({type:"supplier.model.save",supplierId:sid,data:{modelId:`wire-${sid}`,model:{identity:"DeepSeek-V4-Pro",interfaces:["responses"],capabilityStates:{tools:"supported",streaming:"supported",reasoning:"supported"},contextWindow:128000,history:"stateless",reasoning:{modes:["effort"],efforts:["high"]}}}});
 }
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on("pageerror",e=>errors.push(String(e)));page.on("dialog",d=>d.accept());
 await page.goto(app.url);await page.getByRole("button",{name:"供应商",exact:true}).click();
 assert.equal(await page.getByText("使用情况",{exact:true}).count(),0);
 await page.getByRole("button",{name:"Supplier one",exact:true}).click();
 await page.locator('#supplier-form [name="name"]').fill("Official One");await page.getByRole("button",{name:"保存供应商",exact:true}).click();
 await page.getByRole("button",{name:"线路",exact:true}).click();await page.getByRole("button",{name:"新建 Codex 线路",exact:true}).click();
 await page.locator('[name="name"]').fill("Work");await page.locator('[name="suppliers"][value="one"]').check();await page.locator('[name="suppliers"][value="two"]').check();
 assert.equal(await page.locator('[name="candidate"]:checked').count(),0);
 await page.getByRole("button",{name:"选择当前筛选结果",exact:true}).click();await page.getByRole("button",{name:"将勾选模型加入绑定",exact:true}).click();
 assert.equal(await page.locator('[data-inventory-binding]').count(),2);
 await page.locator('[name="defaultModel"]').selectOption("wire-one");await page.getByRole("button",{name:"保存 Cable",exact:true}).click();
 await page.getByRole("button",{name:"预览客户端配置",exact:true}).click();await page.getByText("Codex local config.toml preview",{exact:true}).waitFor();
 await page.getByRole("button",{name:"应用到 Codex",exact:true}).click();await page.getByText("当前激活的 Codex 配置",{exact:true}).waitFor();
 await page.getByRole("button",{name:"撤销接入",exact:true}).click();await page.getByText("尚未激活到 Codex 配置",{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log("Supplier inventory browser checks passed: explicit selection, save, preview, apply and restore.");
} finally {await browser?.close();await app?.close();await fs.rm(home,{recursive:true,force:true});}
