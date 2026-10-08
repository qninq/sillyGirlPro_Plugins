/**
 * @title 系统状态
 * @name status
 * @author qninq
 * @version v1.0.1
 * @desc 发送「状态」查看机器人所在服务器（容器）的运行状态：处理器、CPU/内存/硬盘使用率、系统与内核、进程数、开机与程序启动时间、网络收发、公网/内网 IP。
 * @class 工具类
 * @rule raw ^(状态|系统状态|system|运行状态)$
 * @priority 9
 * @status true
 */

const {
  sender: s,
  utils: { sleep },
} = require("sillygirl");

const os = require("os");
const fs = require("fs");

const TICK = 100; // Linux CLK_TCK，/proc/1/stat 的 starttime 单位

function gb(bytes) {
  const value = bytes / 1024 ** 3;
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${parseFloat(text)}GB`;
}

function percent(value) {
  return `${Math.min(100, Math.max(0, value)).toFixed(2)}%`;
}

function formatDate(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 两次采样 os.cpus() 计算区间 CPU 使用率
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
}

// /etc/os-release → "debian(linux) 12"
function osInfo() {
  try {
    const release = {};
    for (const line of fs.readFileSync("/etc/os-release", "utf8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(?:"(.*)"|(.*))$/);
      if (match) release[match[1]] = match[2] || match[3] || "";
    }
    const id = (release.ID || os.platform()).toLowerCase();
    const version = release.VERSION_ID || os.release();
    return `${id}(${os.type().toLowerCase()}) ${version}`;
  } catch (_) {
    return `${os.platform()} ${os.release()}`;
  }
}

function archName() {
  switch (os.arch()) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    case "ia32":
      return "i686";
    default:
      return os.arch();
  }
}

// /proc 下数字目录即进程（仅 Linux，容器内为容器进程）
function processCount() {
  try {
    return fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).length;
  } catch (_) {
    return null;
  }
}

// /proc/stat 的 btime 行 = 系统开机 epoch 秒
function bootTime() {
  try {
    const match = fs.readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)$/m);
    return match ? parseInt(match[1], 10) : null;
  } catch (_) {
    return null;
  }
}

// PID 1 启动时刻 ≈ 容器/程序启动时间；/proc/1/stat 第 22 字段为开机至今的 jiffies
function pid1StartTime(boot) {
  if (!boot) return null;
  try {
    const stat = fs.readFileSync("/proc/1/stat", "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = parseInt(after[19], 10); // 第 22 字段，去掉 pcomm(2) 后偏移 19
    if (!isFinite(starttime)) return null;
    return boot + Math.floor(starttime / TICK);
  } catch (_) {
    return null;
  }
}

// /proc/net/dev 汇总收发字节（排除 lo 回环）
function networkBytes() {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest) continue;
      if (name.trim() === "lo") continue;
      const columns = rest.trim().split(/\s+/).map(Number);
      rx += columns[0] || 0;
      tx += columns[8] || 0;
    }
    return { rx, tx };
  } catch (_) {
    return null;
  }
}

// 磁盘总量与使用率：优先 fs.statfs（Node 18.15+），回退 df -kP
function diskUsage(mount) {
  try {
    if (typeof fs.statfs === "function") {
      const s = fs.statfsSync(mount);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const used = total - free;
      return { total, usage: (used / total) * 100 };
    }
  } catch (_) {}
  try {
    const { execSync } = require("child_process");
    const line = execSync(`df -kP ${mount}`, { encoding: "utf8" }).trim().split("\n").pop();
    const columns = line.split(/\s+/);
    const total = parseInt(columns[1], 10) * 1024;
    const avail = parseInt(columns[3], 10) * 1024;
    const used = total - avail;
    return { total, usage: (used / total) * 100 };
  } catch (_) {}
  return null;
}

function privateIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (!item.internal && item.family === "IPv4" && item.address) return item.address;
    }
  }
  return "未知";
}

// 依次尝试多个公网 IP 检测源（优先国内可达），从响应中提取 IPv4
async function publicIP() {
  const endpoints = [
    "https://myip.ipip.net",
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://api.ip.sb/geoip",
  ];
  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const text = await response.text();
      const match = text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      if (match) return match[0];
    } catch (_) {}
  }
  return "获取失败";
}

async function main() {
  const lines = [];

  const cpus = os.cpus();
  const cpuModel = (cpus[0] && cpus[0].model ? cpus[0].model.trim() : "未知处理器") || "未知处理器";
  lines.push(`【处理器】${cpuModel}`);
  lines.push(`【核心数】${cpus.length}核心${cpus.length}线程`);

  const t1 = cpuTimes();
  await sleep(300);
  const t2 = cpuTimes();
  const idleDelta = t2.idle - t1.idle;
  const totalDelta = t2.total - t1.total;
  const cpuUsage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
  lines.push(`【CPU使用率】${percent(cpuUsage)}`);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  lines.push(`【内存】${gb(totalMem)}`);
  lines.push(`【内存使用率】${percent(((totalMem - freeMem) / totalMem) * 100)}`);

  const disk = diskUsage("/");
  if (disk) {
    lines.push(`【硬盘】${gb(disk.total)}`);
    lines.push(`【硬盘使用率】${percent(disk.usage)}`);
  }

  lines.push(`【操作系统】${osInfo()}`);
  lines.push(`【Kernel】${os.release()}(${archName()})`);
  lines.push(`【主机名】${os.hostname()}(${os.type().toLowerCase()})`);

  const processes = processCount();
  if (processes !== null) lines.push(`【当前进程数】${processes}`);

  const boot = bootTime();
  if (boot) {
    lines.push(`【开机时间】${formatDate(boot)}`);
    const started = pid1StartTime(boot);
    if (started) lines.push(`【程序启动】${formatDate(started)}`);
  }

  const net = networkBytes();
  if (net) lines.push(`【网络收发】${gb(net.rx)} / ${gb(net.tx)}`);

  lines.push(`【公网IP】${await publicIP()}`);
  lines.push(`【内网IP】${privateIP()}`);

  await s.reply(lines.join("\n"));
}

main();