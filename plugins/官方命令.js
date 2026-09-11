// [title: 官方命令]
// [name: guanFangMingLing]
// [desc: 提供时间、版本、我是谁、更新、升级、重启基础管理命令]
// [author: sillyGirl]
// [version: v1.0.7]
// [rule: ^\s*(时间|time|version|我是谁|myuid|更新|升级|restart)\s*$]
// [on_start: true]
// [status: true]
// [admin: false]
// [public: true]
// [priority: 1]
// [class: 工具]
// [icon: https://api.iconify.design/lucide:bot.svg]
// [origin: 自定义]
// [depe: []]

const { sender: s, Bucket, plugin, utils } = require("sillygirl");

const getSillyGirlVersion = utils.version;
const restartSillyGirl = utils.restart;
const updateSillyGirl = utils.update;

const DEFAULTS = {
  update_timeout: 120,
};

const STATE_BUCKET = "sillyGirl";
const UPDATE_RESTART_NOTICE_KEY = "official_commands_update_restart_notice";

const pluginConfig = new plugin.Form({
  update_timeout: plugin.Form.integer().title("更新超时秒数").min(10).max(600).default(120),
});

async function main() {
  const cmd = String((await s.getMsg()) || "").trim();
  if (!cmd) return notifyPendingRestart();
  if (cmd === "时间" || cmd === "time") return replyTime();
  if (cmd === "版本" || cmd === "version") return replyVersion();
  if (cmd === "我是谁" || cmd === "myuid") return replyIdentity();
  if (cmd === "重启" || cmd === "restart") return restart();
  if (cmd === "更新" || cmd === "升级") return update(await loadConfig());
}

async function loadConfig() {
  try {
    return normalizeConfig(await withTimeout(pluginConfig.get(), 5000, "读取官方命令插件配置超时"));
  } catch (error) {
    await s.reply("读取官方命令配置失败，使用默认配置继续：" + errorText(error));
    return normalizeConfig(DEFAULTS);
  }
}

async function replyTime() {
  const now = new Date();
  await s.reply(
    [
      "当前时间",
      formatDate(now),
      `时间戳：${Math.floor(now.getTime() / 1000)}`,
      `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || "local"}`,
    ].join("\n"),
  );
}

async function replyVersion() {
  const info = await getSillyGirlVersion();
  const bucket = new Bucket("sillyGirl");
  const current = String(info.current || "").trim() || "-";
  const latest = String(info.remote || "").trim() || current;
  const startedAt = await bucket.get("started_at", "");
  const text = ["SillyGirl 版本", `当前版本：${current}`, `最新版本：${latest || current}`];
//   if (info.source) text.push(`来源：${info.source}`);
  if (startedAt) text.push(`启动时间：${startedAt}`);
  text.push(
    current && latest && normalizeVersion(current) !== normalizeVersion(latest) ? "状态：有新版本" : "状态：已是最新",
  );
  await s.reply(text.join("\n"));
}

async function replyIdentity() {
  const [nicknameValue, keyValue] = await Promise.all([s.getUserName(), await s.getUserId()]);
  const key = String(keyValue || "").trim() || "-";
  const nickname = String(nicknameValue || "").trim() || key;
  await s.reply(`${nickname}的key：${key}`);
}

async function restart() {
  if (!(await s.isAdmin())) {
    await s.reply("仅管理员可用");
    return;
  }
  await s.reply("收到重启命令，1 秒后重启");
  await restartSillyGirl();
}

async function update(cfg) {
  const bucket = new Bucket(STATE_BUCKET);
  await s.reply("收到更新命令，正在检查权限");

  if (!(await s.isAdmin())) {
    await s.reply("仅管理员可用");
    return;
  }

  await s.reply("开始更新 SillyGirl");

  try {
    if (typeof updateSillyGirl !== "function") {
      throw new Error("当前 SillyGirl 运行时未导出 update，请先升级主程序到 v0.2.3 或更新插件运行时");
    }
    await bucket.set(UPDATE_RESTART_NOTICE_KEY, {
      at: Date.now(),
      message: "SillyGirl 更新已完成并自动重启成功",
    });
    const result = await withTimeout(
      updateSillyGirl({
        timeout: cfg.update_timeout,
        restart: true,
      }),
      (cfg.update_timeout + 15) * 1000,
      "更新执行超时",
    );
    const lines = [
      result.changed ? "更新完成" : "已经是最新版本",
      `来源：${result.repo || "-"}`,
      `版本：${result.before || "-"} -> ${result.after || "-"}`,
    ];
    const output = compactOutput(result.output);
    if (output) lines.push("输出：\n" + output);
    if (result.restarted) {
      lines.push("已触发自动重启，请等待 1-2 分钟后刷新页面");
    } else {
      lines.push("如需生效，请发送：重启");
    }
    await s.reply(lines.join("\n"));
  } catch (error) {
    await bucket.delete(UPDATE_RESTART_NOTICE_KEY).catch(() => undefined);
    await s.reply(
      "更新失败：" + errorText(error) + "\n" + "请确认当前版本已内置 curl，且 GitHub 加速地址可以访问 Release 文件。",
    );
  }
}

async function notifyPendingRestart() {
  const bucket = new Bucket(STATE_BUCKET);
  const notice = await bucket.get(UPDATE_RESTART_NOTICE_KEY, null);
  if (!notice) return;
  await bucket.delete(UPDATE_RESTART_NOTICE_KEY).catch(() => undefined);

  const info = await getSillyGirlVersion().catch(() => ({}));
  const text = [
    notice.message || "SillyGirl 更新已完成并自动重启成功",
    `当前版本：${String(info.current || "").trim() || "-"}`,
    `最新版本：${String(info.remote || "").trim() || String(info.current || "").trim() || "-"}`,
  ].join("\n");

  try {
    await s.pushAdmin(text);
  } catch (error) {
    console.error("官方命令重启后通知失败：" + errorText(error));
  }
}

function normalizeConfig(input) {
  return Object.assign({}, DEFAULTS, input || {}, {
    update_timeout: clamp(Number((input && input.update_timeout) || DEFAULTS.update_timeout), 10, 600),
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/tags\//, "")
    .replace(/^[vV]/, "");
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function compactOutput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-8).join("\n").slice(0, 1000);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message || "执行超时")), Math.max(1000, timeoutMs));
    }),
  ]);
}

function errorText(error) {
  if (!error) return "未知错误";
  const detail = compactOutput(error.stderr || error.stdout);
  const message = String(error.message || error).trim();
  return detail ? `${message}\n${detail}` : message;
}

main().catch(async (error) => {
  try {
    await s.reply("官方命令异常：" + errorText(error));
  } catch (_) {
    console.error(error);
  }
});
