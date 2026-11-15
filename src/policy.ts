import { resolveToolsBySender } from "openclaw/plugin-sdk/channel-policy";
import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MeshtasticGroupConfig } from "./types.js";

export type MeshtasticGroupMatch = {
  allowed: boolean;
  groupConfig?: MeshtasticGroupConfig;
  wildcardConfig?: MeshtasticGroupConfig;
  hasConfiguredGroups: boolean;
};

export function resolveMeshtasticGroupMatch(params: {
  groups?: Record<string, MeshtasticGroupConfig>;
  target: string;
}): MeshtasticGroupMatch {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;
  const direct = groups[params.target];
  if (direct) {
    return {
      allowed: true,
      groupConfig: direct,
      wildcardConfig: groups["*"],
      hasConfiguredGroups,
    };
  }

  const targetLower = params.target.toLowerCase();
  const directKey = Object.keys(groups).find((key) => key.toLowerCase() === targetLower);
  if (directKey) {
    const matched = groups[directKey];
    if (matched) {
      return {
        allowed: true,
        groupConfig: matched,
        wildcardConfig: groups["*"],
        hasConfiguredGroups,
      };
    }
  }

  const wildcard = groups["*"];
  if (wildcard) {
    return {
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups,
    };
  }

  return {
    allowed: false,
    hasConfiguredGroups,
  };
}

export function resolveMeshtasticRequireMention(params: {
  groupConfig?: MeshtasticGroupConfig;
  wildcardConfig?: MeshtasticGroupConfig;
}): boolean {
  if (params.groupConfig?.requireMention !== undefined) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== undefined) {
    return params.wildcardConfig.requireMention;
  }
  return false;
}

export function hasMeshtasticGroupToolPolicy(
  match: Pick<MeshtasticGroupMatch, "groupConfig" | "wildcardConfig">,
): boolean {
  const configs = [match.wildcardConfig, match.groupConfig];
  return configs.some(
    (config) =>
      config?.tools !== undefined || Object.keys(config?.toolsBySender ?? {}).length > 0,
  );
}

function addDenials(target: string[], seen: Set<string>, denials: string[] | undefined) {
  for (const denial of denials ?? []) {
    if (!seen.has(denial)) {
      seen.add(denial);
      target.push(denial);
    }
  }
}

/**
 * Resolve group tools without ever letting a sender-scoped rule widen the
 * baseline. Sender maps are deny-only by schema; the SDK is used solely for
 * its public sender-key matcher, never for scoped allow/alsoAllow overrides.
 */
export function resolveMeshtasticSenderToolDenials(params: {
  groups?: Record<string, MeshtasticGroupConfig>;
  target?: string | null;
  senderId?: string | null;
  senderPolicyMode?: "always" | "never";
  messageProvider?: string | null;
}): GroupToolPolicyConfig | undefined {
  if (!params.target?.trim()) {
    return undefined;
  }

  const match = resolveMeshtasticGroupMatch({
    groups: params.groups,
    target: params.target,
  });
  const baseline = match.groupConfig?.tools ?? match.wildcardConfig?.tools;

  // A recognized mesh group must retain an adapter-owned neutral policy even
  // when there is nothing to overlay; undefined would invite generic host
  // fallback to select a different (for example inherited root) group map.
  if (params.senderPolicyMode === "never") {
    return baseline ?? { deny: [] };
  }

  const senderDenials: string[] = [];
  const seenSenderDenials = new Set<string>();
  const senderMaps = [match.wildcardConfig?.toolsBySender, match.groupConfig?.toolsBySender].filter(
    (map) => map !== undefined,
  );
  const usableSenderId = params.senderId?.trim() ? params.senderId : undefined;

  for (const toolsBySender of senderMaps) {
    if (!usableSenderId) {
      // Missing sender provenance must not select only the harmless floor or
      // guess a node: conservatively union every configured restriction.
      for (const rule of Object.values(toolsBySender)) {
        addDenials(senderDenials, seenSenderDenials, rule.deny);
      }
      continue;
    }

    // The SDK returns a node-specific match INSTEAD OF its wildcard result.
    // Add the authored floor explicitly, then the matched node rule.
    addDenials(senderDenials, seenSenderDenials, toolsBySender["*"]?.deny);
    const matched = resolveToolsBySender({
      toolsBySender,
      senderId: usableSenderId,
      messageProvider: params.messageProvider ?? "meshtastic",
    });
    addDenials(senderDenials, seenSenderDenials, matched?.deny);
  }

  if (!baseline && senderDenials.length === 0) {
    return { deny: [] };
  }

  const deny: string[] = [];
  const seenDeny = new Set<string>();
  addDenials(deny, seenDeny, baseline?.deny);
  addDenials(deny, seenDeny, senderDenials);
  return { ...(baseline ?? {}), deny };
}
