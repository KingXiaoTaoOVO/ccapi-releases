import { create } from "zustand";

import { probeRemoteServer } from "@/services/tauri";
import { useModeStore } from "@/store/useModeStore";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * 客户端连接守护：
 *  - 每 10s 静默 ping 一次服务端；
 *  - 连续 2 次失败进入"断线"状态，前端整屏蒙层显示「正在尝试重新连接...」；
 *  - 后续按指数退避重试（5s → 10s → 20s → 40s → 60s，60s 封顶），直到恢复；
 *  - 连接恢复后蒙层自动关闭，状态机回到正常心跳；
 *  - 用户在蒙层上可点击「返回模式选择」彻底退出当前服务端。
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const BACKOFFS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const FAIL_THRESHOLD_BEFORE_OFFLINE = 2;

interface ReconnectStore {
  running: boolean;
  /** 是否进入"重连中"状态（已经超过 FAIL_THRESHOLD_BEFORE_OFFLINE 次失败） */
  offline: boolean;
  /** 连续失败次数 */
  failures: number;
  /** 总尝试次数 */
  attempts: number;
  /** 下一次重试的剩余秒数（仅 offline 状态有用，仅供 UI 显示） */
  nextRetryInSecs: number;
  /** 最近一次延迟（ms），用于正常状态指示器 */
  latencyMs: number | null;
  /** 上次心跳时间戳 */
  lastProbeAt: number | null;

  start: () => void;
  stop: () => void;
  /** 立即触发一次 probe；按钮 / 用户手动 retry 用 */
  retryNow: () => Promise<void>;
}

let heartbeatTimer: number | null = null;
let countdownTimer: number | null = null;

function clearTimers() {
  if (heartbeatTimer !== null) {
    window.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

export const useReconnectStore = create<ReconnectStore>((set, get) => ({
  running: false,
  offline: false,
  failures: 0,
  attempts: 0,
  nextRetryInSecs: 0,
  latencyMs: null,
  lastProbeAt: null,

  start: () => {
    if (get().running) return;
    set({
      running: true,
      offline: false,
      failures: 0,
      attempts: 0,
      nextRetryInSecs: 0,
    });
    schedule(0);
  },

  stop: () => {
    clearTimers();
    set({
      running: false,
      offline: false,
      failures: 0,
      attempts: 0,
      nextRetryInSecs: 0,
      latencyMs: null,
    });
  },

  retryNow: async () => {
    clearTimers();
    await probeOnce();
  },
}));

function schedule(delayMs: number) {
  clearTimers();
  const store = useReconnectStore.getState();
  if (!store.running) return;
  if (store.offline && delayMs > 0) {
    // 倒计时显示
    const startedAt = Date.now();
    useReconnectStore.setState({
      nextRetryInSecs: Math.ceil(delayMs / 1000),
    });
    countdownTimer = window.setInterval(() => {
      const remain = Math.max(
        0,
        Math.ceil((delayMs - (Date.now() - startedAt)) / 1000),
      );
      useReconnectStore.setState({ nextRetryInSecs: remain });
      if (remain <= 0 && countdownTimer !== null) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }, 1000);
  }
  heartbeatTimer = window.setTimeout(() => {
    void probeOnce();
  }, delayMs);
}

async function probeOnce() {
  const url = useModeStore.getState().serverUrl;
  if (!url) {
    // 没 URL 直接判定离线
    markFailure();
    return;
  }
  useReconnectStore.setState((s) => ({ attempts: s.attempts + 1 }));
  try {
    const r = await probeRemoteServer(url);
    if (r.ok) {
      markOnline(r.latencyMs ?? null);
    } else {
      markFailure();
    }
  } catch {
    markFailure();
  }
}

function markOnline(latencyMs: number | null) {
  const wasOffline = useReconnectStore.getState().offline;
  useReconnectStore.setState({
    offline: false,
    failures: 0,
    nextRetryInSecs: 0,
    latencyMs,
    lastProbeAt: Date.now(),
  });
  // 恢复后立刻刷新一次用户信息（拉新 token 或 mustChangePassword 等）
  if (wasOffline) {
    void useAuthStore.getState().refreshMe?.();
  }
  // 下一次正常心跳
  schedule(HEARTBEAT_INTERVAL_MS);
}

function markFailure() {
  const s = useReconnectStore.getState();
  const failures = s.failures + 1;
  const offline = failures >= FAIL_THRESHOLD_BEFORE_OFFLINE;
  useReconnectStore.setState({
    failures,
    offline,
    latencyMs: null,
    lastProbeAt: Date.now(),
  });
  // 选择重试延迟
  let delay = HEARTBEAT_INTERVAL_MS;
  if (offline) {
    // 进入退避：用 failures-FAIL_THRESHOLD 作为下标
    const idx = Math.min(failures - FAIL_THRESHOLD_BEFORE_OFFLINE, BACKOFFS_MS.length - 1);
    delay = BACKOFFS_MS[Math.max(0, idx)];
  }
  schedule(delay);
}
