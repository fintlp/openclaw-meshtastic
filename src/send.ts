import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveMeshtasticAccount } from "./accounts.js";
import {
  connectMeshtasticDevice,
  getMeshtasticDevice,
  resolveChannelNumber,
  type MeshtasticDeviceHandle,
} from "./device-client.js";
import { rememberOutboundEcho } from "./echo-dedupe.js";
import {
  formatMeshtasticNodeId,
  isMeshtasticGroupTarget,
  normalizeMeshtasticMessagingTarget,
  parseMeshtasticChannelIndex,
  parseMeshtasticNodeNum,
} from "./normalize.js";
import { getMeshtasticRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendMeshtasticOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
  deviceHandle?: MeshtasticDeviceHandle;
  ackWaitMs?: number;
};

type SendMeshtasticResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

const DEFAULT_CHUNK_LIMIT = 200;
const DEFAULT_SEND_ACK_WAIT_MS = 5_000;

type MeshtasticQueueSnapshotItem = {
  id: number;
  added?: Date;
};

type MeshtasticSendDevice = MeshtasticDeviceHandle["device"] & {
  queue?: {
    getState?: () => MeshtasticQueueSnapshotItem[];
  };
};

function recordMeshtasticOutboundActivity(accountId: string): void {
  try {
    getMeshtasticRuntime().channel.activity.record({
      channel: "meshtastic",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Meshtastic runtime not initialized") {
      throw error;
    }
  }
}

function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const chars = Array.from(trimmed);
  if (chars.length <= limit) {
    return [trimmed];
  }
  const chunks: string[] = [];
  for (let cursor = 0; cursor < chars.length; cursor += limit) {
    chunks.push(chars.slice(cursor, cursor + limit).join(""));
  }
  return chunks;
}

function resolveTarget(to: string, opts?: SendMeshtasticOptions): string {
  const fromArg = normalizeMeshtasticMessagingTarget(to);
  if (fromArg) {
    return fromArg;
  }
  const fromOpt = normalizeMeshtasticMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return fromOpt;
  }
  throw new Error(`Invalid Meshtastic target: ${to}`);
}

function resolveLatestQueuedPacketId(device: MeshtasticSendDevice): number | undefined {
  const state = device.queue?.getState?.();
  if (!state?.length) {
    return undefined;
  }
  return state.reduce((latest, item) => {
    const latestAt = latest.added?.getTime?.() ?? 0;
    const itemAt = item.added?.getTime?.() ?? 0;
    return itemAt >= latestAt ? item : latest;
  }).id;
}

async function waitForMeshtasticSend(params: {
  send: Promise<number>;
  device: MeshtasticSendDevice;
  timeoutMs?: number;
}): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queuedPacketId = resolveLatestQueuedPacketId(params.device);

  try {
    return await Promise.race([
      params.send,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          resolve(resolveLatestQueuedPacketId(params.device) ?? queuedPacketId ?? 0);
        }, params.timeoutMs ?? DEFAULT_SEND_ACK_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.send.catch(() => undefined);
  }
}

async function sendTextWithoutBlockingForAck(params: {
  handle: MeshtasticDeviceHandle;
  text: string;
  destination: number | "broadcast";
  channel?: ReturnType<typeof resolveChannelNumber>;
  replyId?: number;
  ackWaitMs?: number;
}): Promise<number> {
  rememberOutboundEcho(params.text);
  const send = params.handle.device.sendText(
    params.text,
    params.destination,
    true,
    params.channel,
    params.replyId,
  );
  return await waitForMeshtasticSend({
    send,
    device: params.handle.device as MeshtasticSendDevice,
    timeoutMs: params.ackWaitMs,
  });
}

export async function sendMessageMeshtastic(
  to: string,
  text: string,
  opts: SendMeshtasticOptions,
): Promise<SendMeshtasticResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Meshtastic send") as CoreConfig;
  const account = resolveMeshtasticAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      account.transport === "serial"
        ? `Meshtastic is not configured for account "${account.accountId}" (need serialPath in channels.meshtastic).`
        : `Meshtastic is not configured for account "${account.accountId}" (need host in channels.meshtastic).`,
    );
  }

  const target = resolveTarget(to, opts);
  const chunkLimit = account.config.textChunkLimit ?? DEFAULT_CHUNK_LIMIT;
  const chunks = chunkText(text, chunkLimit);
  if (chunks.length === 0) {
    throw new Error("Message must be non-empty for Meshtastic sends");
  }

  const handle =
    opts.deviceHandle ??
    getMeshtasticDevice(account.accountId) ??
    (await connectMeshtasticDevice({
      accountId: account.accountId,
      transport: account.transport,
      host: account.host,
      port: account.port,
      tls: account.tls,
      serialPath: account.serialPath,
      baudRate: account.baudRate,
    }));

  const replyId = opts.replyTo ? Number.parseInt(opts.replyTo, 10) : undefined;
  const parsedReplyId = Number.isFinite(replyId) ? replyId : undefined;

  let lastPacketId = 0;
  if (isMeshtasticGroupTarget(target)) {
    const channelIndex = parseMeshtasticChannelIndex(target) ?? 0;
    const channel = resolveChannelNumber(channelIndex);
    for (const chunk of chunks) {
      lastPacketId = await sendTextWithoutBlockingForAck({
        handle,
        text: chunk,
        destination: "broadcast",
        channel,
        replyId: parsedReplyId,
        ackWaitMs: opts.ackWaitMs,
      });
    }
  } else {
    const nodeNum = parseMeshtasticNodeNum(target);
    if (nodeNum === undefined) {
      throw new Error(`Invalid Meshtastic node target: ${target}`);
    }
    for (const chunk of chunks) {
      lastPacketId = await sendTextWithoutBlockingForAck({
        handle,
        text: chunk,
        destination: nodeNum,
        replyId: parsedReplyId,
        ackWaitMs: opts.ackWaitMs,
      });
    }
  }

  recordMeshtasticOutboundActivity(account.accountId);

  const messageId = String(lastPacketId);
  return {
    messageId,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "meshtastic",
          messageId,
          conversationId: isMeshtasticGroupTarget(target)
            ? target
            : formatMeshtasticNodeId(parseMeshtasticNodeNum(target) ?? 0),
        },
      ],
      kind: "text",
      ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
    }),
  };
}
