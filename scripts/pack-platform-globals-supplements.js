/**
 * One-shot generator: writes src/data/platformGlobals.json from the supplement
 * lists historically maintained in jsLint.ts. Prefer regenerating from an SN
 * export when one exists; merge these as fromSupplement overlays.
 *
 *   node scripts/pack-platform-globals-supplements.js
 */
const fs = require('fs');
const path = require('path');

const server = {
  gs: 'readonly',
  Class: 'readonly',
  SNC: 'readonly',
  GlideRecord: 'readonly',
  GlideRecordSecure: 'readonly',
  GlideAggregate: 'readonly',
  GlideQuery: 'readonly',
  GlideQueryCondition: 'readonly',
  GlideFilter: 'readonly',
  GlideElement: 'readonly',
  GlideTableHierarchy: 'readonly',
  GlideDBFunctionBuilder: 'readonly',
  GlideDateTime: 'readonly',
  GlideDate: 'readonly',
  GlideTime: 'readonly',
  GlideDuration: 'readonly',
  GlideSchedule: 'readonly',
  GlideScheduleDateTime: 'readonly',
  GlideSystem: 'readonly',
  GlideSession: 'readonly',
  GlideUser: 'readonly',
  GlideImpersonate: 'readonly',
  GlideSecurityManager: 'readonly',
  GlideEncrypter: 'readonly',
  GlideDigest: 'readonly',
  GlideSysAttachment: 'readonly',
  GlideStringUtil: 'readonly',
  GlideXMLUtil: 'readonly',
  GlideProperties: 'readonly',
  GlideTemplate: 'readonly',
  GlideURI: 'readonly',
  GlideEmailOutbound: 'readonly',
  GlideTransaction: 'readonly',
  GlideScriptedExtensionPoint: 'readonly',
  GlideSPScriptable: 'readonly',
  sn_ws: 'readonly',
  sn_fd: 'readonly',
  sn_auth: 'readonly',
  sn_sc: 'readonly',
  sn_cmdb: 'readonly',
  sn_impex: 'readonly',
  sn_notification: 'readonly',
  Packages: 'readonly',
  java: 'readonly',
  current: 'readonly',
  previous: 'readonly',
  g_scratchpad: 'writable',
  workflow: 'readonly',
  activity: 'readonly',
  action: 'readonly',
  event: 'readonly',
  producer: 'readonly',
  template: 'readonly',
  email: 'readonly',
  email_action: 'readonly',
  request: 'readonly',
  response: 'readonly',
  RP: 'readonly',
  AbstractAjaxProcessor: 'readonly'
};

const client = {
  g_form: 'readonly',
  g_user: 'readonly',
  g_list: 'readonly',
  g_scratchpad: 'writable',
  g_navigation: 'readonly',
  g_document: 'readonly',
  g_i18n: 'readonly',
  g_modal: 'readonly',
  g_menu: 'readonly',
  g_service_catalog: 'readonly',
  GlideAjax: 'readonly',
  GlideRecord: 'readonly',
  GlideModal: 'readonly',
  GlideModalForm: 'readonly',
  GlideDialogWindow: 'readonly',
  GlideList2: 'readonly',
  GlideMenu: 'readonly',
  GlideURL: 'readonly',
  GlideForm: 'readonly',
  GlideUser: 'readonly',
  NOW: 'readonly',
  spModal: 'readonly',
  spUtil: 'readonly',
  gel: 'readonly',
  getMessage: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  console: 'readonly',
  document: 'readonly',
  window: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  history: 'readonly',
  top: 'readonly',
  parent: 'readonly',
  fetch: 'readonly',
  CustomEvent: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  jQuery: 'readonly',
  $: 'readonly',
  $j: 'readonly',
  angular: 'readonly',
  imports: 'readonly',
  api: 'readonly',
  CustomEventManager: 'readonly',
  DevStudio: 'readonly',
  GJSV: 'readonly',
  NOW_UCM_INFO: 'readonly',
  Prism: 'readonly',
  alertDeprecated: 'readonly',
  amb: 'readonly',
  appliedPageFragmentsPromise: 'readonly',
  breakpointHitAlert: 'readonly',
  caml_fs_tmp: 'readonly',
  coreui_total_ui_time: 'readonly',
  ephox: 'readonly',
  frameBusterRouteChangeWithoutRedirect: 'readonly',
  g_ambClient: 'readonly',
  g_application_picker: 'readonly',
  g_ck: 'readonly',
  g_first_day_of_week: 'readonly',
  g_tiny_url: 'readonly',
  g_tz: 'readonly',
  g_tz_offset: 'readonly',
  g_tz_user_offset: 'readonly',
  g_user_date_format: 'readonly',
  g_user_date_time_format: 'readonly',
  gsft_main: 'readonly',
  initDevStudioLauncher: 'readonly',
  interopPatch: 'readonly',
  jsoo_create_file: 'readonly',
  launchScriptDebugger: 'readonly',
  launchScriptDebuggerOK: 'readonly',
  loadScriptWhenIdle: 'readonly',
  now: 'readonly',
  nowAnalytics: 'readonly',
  nowUiFramework: 'readonly',
  nowUiFrameworkLogs: 'readonly',
  nowUiFrameworkMetrics: 'readonly',
  nowWindowManager: 'readonly',
  pageMeta: 'readonly',
  popupOpenFocus: 'readonly',
  regeneratorRuntime: 'readonly',
  resolveApfPromise: 'readonly',
  resolveSubscreenPromise: 'readonly',
  serviceWorkerManager: 'readonly',
  snmCabrillo: 'readonly',
  subscreenPromise: 'readonly',
  tectonicVarWrapperState: 'readonly',
  tinyMCE: 'readonly',
  tinymce: 'readonly',
  transaction_source: 'readonly',
  triggerSoftwareUpdateFlow: 'readonly',
  uxPageSessionDebug: 'readonly',
  ux_globals: 'readonly',
  uxf: 'readonly',
  uxfIntentLibrary: 'readonly',
  uxfTriggerLibrary: 'readonly',
  uxf_timing: 'readonly',
  wrapTectonicVarIfNeeded: 'readonly'
};

const byName = new Map();
for (const [name, mode] of Object.entries(server)) {
  byName.set(name, {
    name,
    profile: 'server',
    writable: mode === 'writable',
    fromSupplement: true
  });
}
for (const [name, mode] of Object.entries(client)) {
  const existing = byName.get(name);
  if (existing) {
    existing.profile = 'both';
    if (mode === 'writable') {
      existing.writable = true;
    }
  } else {
    byName.set(name, {
      name,
      profile: 'client',
      writable: mode === 'writable',
      fromSupplement: true
    });
  }
}

const outPath = path.join(__dirname, '..', 'src', 'data', 'platformGlobals.json');
const pack = { version: 1, globals: [...byName.values()] };
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + '\n');
console.log(`Wrote ${pack.globals.length} globals to ${outPath}`);
