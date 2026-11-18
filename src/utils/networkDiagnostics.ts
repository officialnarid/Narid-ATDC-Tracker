// ============================================================================
// NARID ATDC Tracker — Isomorphic Internet & Network Performance Diagnostics
// ============================================================================
// Pure deterministic evaluators shared by Backend Telemetry & Frontend UI.
// Zero ambient dependencies — distinguishes Actual Measurements vs Estimates.
// ============================================================================

export type NetworkLatencyRating =
  | 'EXCELLENT'
  | 'GOOD'
  | 'WARNING'
  | 'POOR'
  | 'CRITICAL'
  | 'UNKNOWN';

export type NetworkTierRating = 'GOOD' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

export type InternetHealthScoreTier =
  | 'EXCELLENT'
  | 'GOOD'
  | 'FAIR'
  | 'POOR'
  | 'CRITICAL'
  | 'UNKNOWN';

export type RootCauseCategory =
  | 'User Internet Problem'
  | 'Backend Server Problem'
  | 'Firebase / Database Problem'
  | 'Frontend Problem'
  | 'All Systems Nominal'
  | 'Cause Unknown';

export interface NetworkThresholdConfig {
  netLatencyGoodMaxMs: number;
  netLatencyWarnMaxMs: number;
  netLatencyPoorMaxMs: number;
  netLatencyCriticalMinMs: number;
  netJitterGoodMaxMs: number;
  netJitterWarnMaxMs: number;
  netPacketLossGoodMaxPct: number;
  netPacketLossWarnMaxPct: number;
  netDownloadGoodMinMbps: number;
  netDownloadWarnMinMbps: number;
  netUploadGoodMinMbps: number;
  netUploadWarnMinMbps: number;
  netProbeIntervalSec: number;
  netNetworkFailureSpikeCount: number;
  apiP95WarningMs: number;
}

export const DEFAULT_NETWORK_THRESHOLDS: NetworkThresholdConfig = {
  netLatencyGoodMaxMs: 50,
  netLatencyWarnMaxMs: 100,
  netLatencyPoorMaxMs: 200,
  netLatencyCriticalMinMs: 400,
  netJitterGoodMaxMs: 20,
  netJitterWarnMaxMs: 50,
  netPacketLossGoodMaxPct: 0.5,
  netPacketLossWarnMaxPct: 2.0,
  netDownloadGoodMinMbps: 10,
  netDownloadWarnMinMbps: 5,
  netUploadGoodMinMbps: 5,
  netUploadWarnMinMbps: 2,
  netProbeIntervalSec: 30,
  netNetworkFailureSpikeCount: 3,
  apiP95WarningMs: 1200,
};

export interface NumericStatsSummary {
  count: number;
  min: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  last: number | null;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function computeNumericStats(values: number[]): NumericStatsSummary {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (clean.length === 0) {
    return { count: 0, min: null, avg: null, p50: null, p95: null, max: null, last: null };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const p = (pct: number) =>
    round2(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1))]);
  return {
    count: sorted.length,
    min: round2(sorted[0]),
    avg: round2(sum / sorted.length),
    p50: p(50),
    p95: p(95),
    max: round2(sorted[sorted.length - 1]),
    last: round2(clean[clean.length - 1]),
  };
}

export function classifyLatencyRating(
  rttMs: number | null | undefined,
  cfg: Partial<NetworkThresholdConfig> = {}
): NetworkLatencyRating {
  if (rttMs === null || rttMs === undefined || !Number.isFinite(rttMs) || rttMs < 0) {
    return 'UNKNOWN';
  }
  const goodMax = cfg.netLatencyGoodMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyGoodMaxMs;
  const warnMax = cfg.netLatencyWarnMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyWarnMaxMs;
  const poorMax = cfg.netLatencyPoorMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyPoorMaxMs;
  const critMin = cfg.netLatencyCriticalMinMs ?? DEFAULT_NETWORK_THRESHOLDS.netLatencyCriticalMinMs;

  if (rttMs <= goodMax) return 'EXCELLENT';
  if (rttMs <= warnMax) return 'GOOD';
  if (rttMs <= poorMax) return 'WARNING';
  if (rttMs <= critMin) return 'POOR';
  return 'CRITICAL';
}

export function classifyJitterRating(
  jitterMs: number | null | undefined,
  cfg: Partial<NetworkThresholdConfig> = {}
): NetworkTierRating {
  if (jitterMs === null || jitterMs === undefined || !Number.isFinite(jitterMs) || jitterMs < 0) {
    return 'UNKNOWN';
  }
  const goodMax = cfg.netJitterGoodMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netJitterGoodMaxMs;
  const warnMax = cfg.netJitterWarnMaxMs ?? DEFAULT_NETWORK_THRESHOLDS.netJitterWarnMaxMs;
  if (jitterMs < goodMax) return 'GOOD';
  if (jitterMs <= warnMax) return 'WARNING';
  return 'CRITICAL';
}

export function classifyPacketLossRating(
  lossPct: number | null | undefined,
  cfg: Partial<NetworkThresholdConfig> = {}
): NetworkTierRating {
  if (lossPct === null || lossPct === undefined || !Number.isFinite(lossPct) || lossPct < 0) {
    return 'UNKNOWN';
  }
  const goodMax = cfg.netPacketLossGoodMaxPct ?? DEFAULT_NETWORK_THRESHOLDS.netPacketLossGoodMaxPct;
  const warnMax = cfg.netPacketLossWarnMaxPct ?? DEFAULT_NETWORK_THRESHOLDS.netPacketLossWarnMaxPct;
  if (lossPct <= goodMax) return 'GOOD';
  if (lossPct <= warnMax) return 'WARNING';
  return 'CRITICAL';
}

export function classifyDownloadRating(
  mbps: number | null | undefined,
  cfg: Partial<NetworkThresholdConfig> = {}
): NetworkTierRating {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps) || mbps < 0) {
    return 'UNKNOWN';
  }
  const goodMin = cfg.netDownloadGoodMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netDownloadGoodMinMbps;
  const warnMin = cfg.netDownloadWarnMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netDownloadWarnMinMbps;
  if (mbps >= goodMin) return 'GOOD';
  if (mbps >= warnMin) return 'WARNING';
  return 'CRITICAL';
}

export function classifyUploadRating(
  mbps: number | null | undefined,
  cfg: Partial<NetworkThresholdConfig> = {}
): NetworkTierRating {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps) || mbps < 0) {
    return 'UNKNOWN';
  }
  const goodMin = cfg.netUploadGoodMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netUploadGoodMinMbps;
  const warnMin = cfg.netUploadWarnMinMbps ?? DEFAULT_NETWORK_THRESHOLDS.netUploadWarnMinMbps;
  if (mbps >= goodMin) return 'GOOD';
  if (mbps >= warnMin) return 'WARNING';
  return 'CRITICAL';
}

/**
 * Computes jitter (mean absolute consecutive RTT variation) strictly from >= 3 successful RTT probes.
 */
export function computeJitterFromRttSeries(successfulRtts: number[]): number | null {
  const clean = successfulRtts.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (clean.length < 3) return null;
  let totalDiff = 0;
  for (let i = 1; i < clean.length; i++) {
    totalDiff += Math.abs(clean[i] - clean[i - 1]);
  }
  return round2(totalDiff / (clean.length - 1));
}

export interface PacketLossEvaluation {
  totalProbes: number;
  failedProbes: number;
  rawFailurePct: number | null;
  reportablePacketLossPct: number | null;
  rating: NetworkTierRating;
  note: string;
}

/**
 * Evaluates packet loss safely using repeated lightweight probes.
 * Requirement: "Use repeated lightweight probes and sufficient samples before reporting packet loss
 * or jitter. Do not label a single failed HTTPS request as packet loss."
 */
export function evaluatePacketLoss(
  probeOutcomes: Array<{ success: boolean }>,
  cfg: Partial<NetworkThresholdConfig> = {}
): PacketLossEvaluation {
  const total = probeOutcomes.length;
  const failed = probeOutcomes.filter((p) => !p.success).length;
  if (total < 5) {
    return {
      totalProbes: total,
      failedProbes: failed,
      rawFailurePct: total > 0 ? round2((failed / total) * 100) : null,
      reportablePacketLossPct: null,
      rating: 'UNKNOWN',
      note: `Collecting samples (${total}/5 minimum probes required before classifying packet loss)`,
    };
  }

  const rawPct = round2((failed / total) * 100);
  if (failed === 1) {
    // Do NOT label a single failed HTTPS request as packet loss
    return {
      totalProbes: total,
      failedProbes: 1,
      rawFailurePct: rawPct,
      reportablePacketLossPct: 0,
      rating: 'GOOD',
      note: `1 isolated failed HTTPS probe out of ${total} (not classified as sustained packet loss)`,
    };
  }

  return {
    totalProbes: total,
    failedProbes: failed,
    rawFailurePct: rawPct,
    reportablePacketLossPct: rawPct,
    rating: classifyPacketLossRating(rawPct, cfg),
    note:
      failed === 0
        ? `0% probe loss across ${total} measured HTTP probes`
        : `${failed}/${total} probes failed (${rawPct}% loss)`,
  };
}

export interface HealthScoreFactorBreakdown {
  factor: 'Latency (App RTT)' | 'Jitter' | 'Packet Loss' | 'Throughput';
  measuredValue: string;
  weightPct: number;
  subScore: number | null;
  status: string;
  included: boolean;
}

export interface InternetHealthScoreResult {
  score: number | null; // 0-100, or null when UNKNOWN
  tier: InternetHealthScoreTier;
  formulaSummary: string;
  factors: HealthScoreFactorBreakdown[];
}

export function computeInternetHealthScore(params: {
  online: boolean;
  probeCount: number;
  successfulProbeCount: number;
  avgRttMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  thresholds?: Partial<NetworkThresholdConfig>;
}): InternetHealthScoreResult {
  const cfg = { ...DEFAULT_NETWORK_THRESHOLDS, ...(params.thresholds || {}) };

  if (!params.online) {
    return {
      score: 0,
      tier: 'CRITICAL',
      formulaSummary: 'Browser offline or all active health probes unreachable (Score = 0 / CRITICAL).',
      factors: [
        {
          factor: 'Latency (App RTT)',
          measuredValue: 'Offline / Unreachable',
          weightPct: 100,
          subScore: 0,
          status: 'CRITICAL',
          included: true,
        },
      ],
    };
  }

  if (params.probeCount < 3 || params.successfulProbeCount < 1 || params.avgRttMs === null) {
    if (params.probeCount >= 3 && params.successfulProbeCount === 0) {
      return {
        score: 0,
        tier: 'CRITICAL',
        formulaSummary: `${params.probeCount} consecutive HTTP probes failed with zero responses (Score = 0 / CRITICAL).`,
        factors: [
          {
            factor: 'Packet Loss',
            measuredValue: '100%',
            weightPct: 100,
            subScore: 0,
            status: 'CRITICAL',
            included: true,
          },
        ],
      };
    }
    return {
      score: null,
      tier: 'UNKNOWN',
      formulaSummary: `Insufficient probes (${params.probeCount}/3 minimum). Waiting for real measurements rather than estimating.`,
      factors: [],
    };
  }

  // Factor 1: Latency (Base Weight 40)
  const latRating = classifyLatencyRating(params.avgRttMs, cfg);
  const latSubScore =
    latRating === 'EXCELLENT'
      ? 100
      : latRating === 'GOOD'
        ? 85
        : latRating === 'WARNING'
          ? 62
          : latRating === 'POOR'
            ? 35
            : 10;

  // Factor 2: Jitter (Base Weight 25)
  const jitterRating = classifyJitterRating(params.jitterMs, cfg);
  const jitterSubScore =
    jitterRating === 'GOOD'
      ? 100
      : jitterRating === 'WARNING'
        ? 60
        : jitterRating === 'CRITICAL'
          ? 15
          : null;

  // Factor 3: Packet Loss (Base Weight 25)
  const lossRating = classifyPacketLossRating(params.packetLossPct, cfg);
  const lossSubScore =
    lossRating === 'GOOD'
      ? 100
      : lossRating === 'WARNING'
        ? 55
        : lossRating === 'CRITICAL'
          ? 10
          : null;

  // Factor 4: Throughput (Base Weight 10 — only included if manually tested)
  const dlRating = classifyDownloadRating(params.downloadMbps, cfg);
  const ulRating = classifyUploadRating(params.uploadMbps, cfg);
  const scoreMap = { GOOD: 100, WARNING: 60, CRITICAL: 20 } as const;
  const speedScores: number[] = [];
  if (dlRating !== 'UNKNOWN') speedScores.push(scoreMap[dlRating]);
  if (ulRating !== 'UNKNOWN') speedScores.push(scoreMap[ulRating]);
  const throughputSubScore =
    speedScores.length > 0
      ? round2(speedScores.reduce((a, b) => a + b, 0) / speedScores.length)
      : null;

  const rawFactors: Array<{
    factor: HealthScoreFactorBreakdown['factor'];
    measuredValue: string;
    baseWeight: number;
    subScore: number | null;
    status: string;
  }> = [
    {
      factor: 'Latency (App RTT)',
      measuredValue: `${params.avgRttMs} ms`,
      baseWeight: 40,
      subScore: latSubScore,
      status: latRating,
    },
    {
      factor: 'Jitter',
      measuredValue: params.jitterMs !== null ? `${params.jitterMs} ms` : 'Pending (>=3 probes)',
      baseWeight: 25,
      subScore: jitterSubScore,
      status: jitterRating,
    },
    {
      factor: 'Packet Loss',
      measuredValue:
        params.packetLossPct !== null ? `${params.packetLossPct}%` : 'Pending (>=5 probes)',
      baseWeight: 25,
      subScore: lossSubScore,
      status: lossRating,
    },
    {
      factor: 'Throughput',
      measuredValue:
        params.downloadMbps !== null || params.uploadMbps !== null
          ? `↓${params.downloadMbps ?? '—'} / ↑${params.uploadMbps ?? '—'} Mbps`
          : 'Not tested yet',
      baseWeight: 10,
      subScore: throughputSubScore,
      status:
        throughputSubScore === null
          ? 'UNKNOWN'
          : throughputSubScore >= 85
            ? 'GOOD'
            : throughputSubScore >= 50
              ? 'WARNING'
              : 'CRITICAL',
    },
  ];

  const activeWeightSum = rawFactors.reduce(
    (sum, f) => (f.subScore !== null ? sum + f.baseWeight : sum),
    0
  );

  let weightedScore = 0;
  const factors: HealthScoreFactorBreakdown[] = rawFactors.map((f) => {
    const included = f.subScore !== null && activeWeightSum > 0;
    const effectiveWeightPct = included ? round2((f.baseWeight / activeWeightSum) * 100) : 0;
    if (included && f.subScore !== null) {
      weightedScore += (f.subScore * effectiveWeightPct) / 100;
    }
    return {
      factor: f.factor,
      measuredValue: f.measuredValue,
      weightPct: effectiveWeightPct,
      subScore: f.subScore,
      status: f.status,
      included,
    };
  });

  const finalScore = Math.max(0, Math.min(100, Math.round(weightedScore)));
  let tier: InternetHealthScoreTier = 'EXCELLENT';
  if (finalScore >= 90) tier = 'EXCELLENT';
  else if (finalScore >= 75) tier = 'GOOD';
  else if (finalScore >= 55) tier = 'FAIR';
  else if (finalScore >= 35) tier = 'POOR';
  else tier = 'CRITICAL';

  const includedLabels = factors
    .filter((f) => f.included)
    .map((f) => `${f.factor} (${f.weightPct}%)`)
    .join(' + ');

  return {
    score: finalScore,
    tier,
    formulaSummary: `Weighted score (${finalScore}/100) computed from ${includedLabels}.`,
    factors,
  };
}

export interface DiagnosticEvidenceInput {
  online: boolean;
  probeCount: number;
  successfulProbeCount: number;
  avgRttMs: number | null;
  p95RttMs: number | null;
  avgServerProbeProcessMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  networkRequestFailureRatePct: number | null;
  apiSampleCount: number;
  apiAvgMs: number | null;
  apiP95Ms: number | null;
  apiServerErrorCount: number;
  apiTimeoutCount: number;
  dbOpCount: number;
  dbAvgOpMs: number | null;
  dbP95OpMs: number | null;
  dbErrorCount: number;
  dbTxFailureCount: number;
  frontendPerfCount: number;
  frontendSlowRenderAvgMs: number | null;
  frontendSlowRenderCount: number;
  frontendNavAvgMs: number | null;
  thresholds?: Partial<NetworkThresholdConfig>;
}

export interface NetworkDiagnosticResult {
  primaryCause: RootCauseCategory;
  confidence: 'High' | 'Medium' | 'Low' | 'Unknown';
  summary: string;
  evidenceBullets: string[];
  comparison: {
    appRttAvgMs: number | null;
    backendApiP95Ms: number | null;
    firestoreP95Ms: number | null;
    frontendSlowRenderAvgMs: number | null;
  };
}

/**
 * Separates User Internet problems vs Backend Server problems vs Firebase/Database problems vs Frontend problems.
 * Never guesses: returns "Cause Unknown" when sample coverage is insufficient.
 */
export function diagnoseNetworkVsServer(input: DiagnosticEvidenceInput): NetworkDiagnosticResult {
  const cfg = { ...DEFAULT_NETWORK_THRESHOLDS, ...(input.thresholds || {}) };
  const evidence: string[] = [];

  const comparison = {
    appRttAvgMs: input.avgRttMs,
    backendApiP95Ms: input.apiP95Ms,
    firestoreP95Ms: input.dbP95OpMs,
    frontendSlowRenderAvgMs: input.frontendSlowRenderAvgMs,
  };

  // 1. Disconnected / Total Loss -> Clear User Internet Problem
  if (!input.online) {
    return {
      primaryCause: 'User Internet Problem',
      confidence: 'High',
      summary: 'Browser reports offline state — device lacks an active internet connection.',
      evidenceBullets: ['navigator.onLine is false', 'No outbound requests can complete until connectivity resumes.'],
      comparison,
    };
  }

  if (input.probeCount >= 2 && input.successfulProbeCount === 0) {
    return {
      primaryCause: 'User Internet Problem',
      confidence: 'High',
      summary: 'All recent HTTP connectivity probes failed to reach the server.',
      evidenceBullets: [
        `0 of ${input.probeCount} lightweight HTTP probes succeeded.`,
        'Check local Wi-Fi, ISP link, VPN, or corporate firewall.',
      ],
      comparison,
    };
  }

  // 2. Insufficient evidence guard -> Never guess
  if (input.probeCount < 2 && input.apiSampleCount < 3 && input.dbOpCount === 0 && input.frontendPerfCount === 0) {
    return {
      primaryCause: 'Cause Unknown',
      confidence: 'Unknown',
      summary: 'Insufficient measured network, API, or database telemetry samples to determine root cause.',
      evidenceBullets: ['Collect at least 3 network probes and API samples before isolating latency origin.'],
      comparison,
    };
  }

  // Compute component problem scores from real measured evidence
  const netGoodMax = cfg.netLatencyWarnMaxMs; // 100ms
  const netPoorMax = cfg.netLatencyPoorMaxMs; // 200ms

  let internetScore = 0;
  let firebaseScore = 0;
  let backendScore = 0;
  let frontendScore = 0;

  // --- Signal Group A: User Internet ---
  const pureTransportRtt =
    input.avgRttMs !== null
      ? Math.max(0, input.avgRttMs - (input.avgServerProbeProcessMs ?? 0))
      : null;

  if (pureTransportRtt !== null && pureTransportRtt > netPoorMax) {
    internetScore += pureTransportRtt > cfg.netLatencyCriticalMinMs ? 50 : 35;
    evidence.push(
      `High application HTTP transport RTT (${round2(pureTransportRtt)} ms avg, P95 ${input.p95RttMs ?? '—'} ms) while probe handler processing took ${input.avgServerProbeProcessMs ?? 0} ms.`
    );
  }
  if (input.jitterMs !== null && input.jitterMs > cfg.netJitterWarnMaxMs) {
    internetScore += 30;
    evidence.push(`Elevated connection jitter (${input.jitterMs} ms > ${cfg.netJitterWarnMaxMs} ms threshold).`);
  } else if (input.jitterMs !== null && input.jitterMs > cfg.netJitterGoodMaxMs) {
    internetScore += 15;
    evidence.push(`Moderate jitter (${input.jitterMs} ms).`);
  }
  if (input.packetLossPct !== null && input.packetLossPct > cfg.netPacketLossWarnMaxPct) {
    internetScore += 45;
    evidence.push(`Sustained HTTP probe packet loss (${input.packetLossPct}% > ${cfg.netPacketLossWarnMaxPct}%).`);
  }
  if (
    (input.downloadMbps !== null && input.downloadMbps < cfg.netDownloadWarnMinMbps) ||
    (input.uploadMbps !== null && input.uploadMbps < cfg.netUploadWarnMinMbps)
  ) {
    internetScore += 30;
    evidence.push(
      `Low measured bandwidth (↓${input.downloadMbps ?? '—'} Mbps / ↑${input.uploadMbps ?? '—'} Mbps).`
    );
  }
  if (
    input.networkRequestFailureRatePct !== null &&
    input.networkRequestFailureRatePct >= 10 &&
    input.apiServerErrorCount === 0
  ) {
    internetScore += 25;
    evidence.push(
      `Client network requests failing (${input.networkRequestFailureRatePct}%) without server 5xx errors.`
    );
  }

  // --- Signal Group C: Firebase / Firestore ---
  const dbP95Slow = input.dbP95OpMs !== null && input.dbP95OpMs >= 500;
  const dbAvgSlow = input.dbAvgOpMs !== null && input.dbAvgOpMs >= 300;
  if (dbP95Slow || dbAvgSlow) {
    firebaseScore += input.dbP95OpMs && input.dbP95OpMs >= 900 ? 55 : 40;
    evidence.push(
      `Firestore operation latency elevated (Avg ${input.dbAvgOpMs ?? '—'} ms, P95 ${input.dbP95OpMs ?? '—'} ms across ${input.dbOpCount} op(s)).`
    );
  }
  if (input.dbErrorCount > 0 || input.dbTxFailureCount > 0) {
    firebaseScore += 50;
    evidence.push(
      `Firestore recorded ${input.dbErrorCount} DB error(s) and ${input.dbTxFailureCount} failed transaction(s).`
    );
  }

  // --- Signal Group B: Backend Server ---
  const netIsHealthyOrNormal = pureTransportRtt === null || pureTransportRtt <= netPoorMax;
  const apiIsSlow =
    (input.apiP95Ms !== null && input.apiP95Ms >= Math.min(cfg.apiP95WarningMs, 800)) ||
    (input.apiAvgMs !== null && input.apiAvgMs >= 450);

  // Subtract DB explanation if DB accounts for the majority of slowness
  const dbExplainsApiSlow =
    dbP95Slow && input.apiP95Ms !== null && (input.dbP95OpMs ?? 0) >= input.apiP95Ms * 0.45;

  if (apiIsSlow && !dbExplainsApiSlow) {
    backendScore += input.apiP95Ms && input.apiP95Ms >= cfg.apiP95WarningMs ? 45 : 30;
    evidence.push(
      `Backend API latency elevated (Avg ${input.apiAvgMs ?? '—'} ms, P95 ${input.apiP95Ms ?? '—'} ms)${netIsHealthyOrNormal ? ' while network RTT remains normal' : ''}.`
    );
  }
  if (input.apiServerErrorCount > 0 || input.apiTimeoutCount > 0) {
    backendScore += 40;
    evidence.push(
      `Backend returned ${input.apiServerErrorCount} HTTP 5xx error(s) and ${input.apiTimeoutCount} timeout(s).`
    );
  }

  // --- Signal Group D: Frontend Rendering / Bundle Loading ---
  const backendHealthy = !apiIsSlow && input.apiServerErrorCount === 0;
  if (
    netIsHealthyOrNormal &&
    backendHealthy &&
    ((input.frontendSlowRenderAvgMs !== null && input.frontendSlowRenderAvgMs >= 250) ||
      input.frontendSlowRenderCount >= 2 ||
      (input.frontendNavAvgMs !== null && input.frontendNavAvgMs >= 1000))
  ) {
    frontendScore += 40;
    evidence.push(
      `Browser main-thread / navigation delay detected (slow render avg ${input.frontendSlowRenderAvgMs ?? '—'} ms, nav avg ${input.frontendNavAvgMs ?? '—'} ms) while network & API are fast.`
    );
  }

  // Rank candidates
  const candidates: Array<{ cat: RootCauseCategory; score: number }> = [
    { cat: 'User Internet Problem', score: internetScore },
    { cat: 'Firebase / Database Problem', score: firebaseScore },
    { cat: 'Backend Server Problem', score: backendScore },
    { cat: 'Frontend Problem', score: frontendScore },
  ];
  const ranked = candidates.sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (top.score === 0) {
    // Check if we actually have positive healthy evidence
    if (input.probeCount >= 2 || input.apiSampleCount >= 3) {
      const healthyBullets: string[] = [];
      if (pureTransportRtt !== null) {
        healthyBullets.push(
          `Application HTTP RTT avg ${round2(pureTransportRtt)} ms (within <= ${netGoodMax}–${netPoorMax} ms SLA).`
        );
      }
      if (input.apiP95Ms !== null) {
        healthyBullets.push(`Backend API P95 ${input.apiP95Ms} ms with ${input.apiServerErrorCount} server errors.`);
      }
      if (input.dbP95OpMs !== null) {
        healthyBullets.push(`Firestore P95 ${input.dbP95OpMs} ms with ${input.dbErrorCount} DB errors.`);
      }
      return {
        primaryCause: 'All Systems Nominal',
        confidence: input.probeCount >= 3 ? 'High' : 'Medium',
        summary: 'Network transport, backend handlers, database operations, and frontend timings are operating within thresholds.',
        evidenceBullets: healthyBullets,
        comparison,
      };
    }

    return {
      primaryCause: 'Cause Unknown',
      confidence: 'Unknown',
      summary: 'Measured samples are insufficient to isolate latency origin.',
      evidenceBullets: evidence,
      comparison,
    };
  }

  const confidence: NetworkDiagnosticResult['confidence'] =
    top.score >= 45 ? 'High' : top.score >= 25 ? 'Medium' : 'Low';

  const summaryMap: Record<Exclude<RootCauseCategory, 'All Systems Nominal' | 'Cause Unknown'>, string> = {
    'User Internet Problem':
      'Latency or failures originate primarily on the client network link (high HTTP RTT, jitter, packet loss, or low throughput).',
    'Backend Server Problem':
      'Client network and database timings are healthy, but backend Express API processing or error rates are elevated.',
    'Firebase / Database Problem':
      'Client connectivity and backend ingress are healthy; delays or errors stem from Firestore queries, writes, or transactions.',
    'Frontend Problem':
      'Network RTT and API responses are fast; slowness is isolated to browser UI rendering or module loading.',
  };

  return {
    primaryCause: top.cat,
    confidence,
    summary:
      top.cat === 'User Internet Problem' ||
      top.cat === 'Backend Server Problem' ||
      top.cat === 'Firebase / Database Problem' ||
      top.cat === 'Frontend Problem'
        ? summaryMap[top.cat]
        : 'Measured symptoms evaluated.',
    evidenceBullets: evidence,
    comparison,
  };
}
