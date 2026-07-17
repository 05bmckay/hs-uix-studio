import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  BarChart,
  Button,
  DescriptionList,
  DescriptionListItem,
  EmptyState,
  Flex,
  Icon,
  Input,
  Link,
  LineChart,
  LoadingSpinner,
  Panel,
  PanelBody,
  PanelFooter,
  PanelSection,
  ProgressBar,
  Select,
  Statistics,
  StatisticsItem,
  StatusTag,
  Tab,
  Tabs,
  Tag,
  Text,
  Tile,
  useExtensionApi,
} from "@hubspot/ui-extensions";
import { DataTable } from "hs-uix";
import { PageTitle } from "@hubspot/ui-extensions/pages";

import { useProjects } from "../state/projects.jsx";
import { workerApi } from "../lib/worker.js";
import { BACKEND_ENABLED } from "../config.js";

// Settings & Usage — a portal-scoped report on the Studio installation.
// Reads everything from a single /usage/summary endpoint so the three
// tabs stay in sync and a window change is one round-trip.
//
// Formatting lives on the client: the worker returns raw numbers
// (token counts, cost in cents, ms durations) and we format on render.

// 872000 → "872K", 1_240_000 → "1.24M". Under 1k falls through as-is.
const formatTokens = (n) => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};

// Worker stores cost in micro-cents (1¢ = 1000 µ¢) so cheap calls like the
// chat-title upgrade don't round to 0. $1 = 100_000 µ¢. Show 4 decimals when
// the amount is under a cent so a $0.0002 cost still renders honestly.
const formatCents = (microCents) => {
  if (microCents == null) return "—";
  const dollars = microCents / 100_000;
  if (dollars === 0) return "$0.00";
  if (Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
};

const formatLatency = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

// Rough "N minutes/hours/days ago" without pulling in a date lib.
const formatRelative = (ts) => {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
};

// "Jane Doe" if we resolved the user via crm.objects.users.read, else
// "jane@acme.com", else "User #12345" as a last-resort placeholder.
const userLabel = (id, name, email) => name || email || `User #${id}`;

// Delta % → StatusTag variant. Down is good (less spend); up is warning/danger.
const deltaVariant = (pct) => {
  if (pct == null) return "default";
  if (pct <= -5) return "success";
  if (pct < 10) return "default";
  if (pct < 25) return "warning";
  return "danger";
};

const deltaLabel = (pct, isNew) => {
  if (isNew) return "New";
  if (pct == null) return "—";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct)}% vs prev.`;
};

// Turn the worker's [{day, input, output}] into the two-series shape
// LineChart wants (one row per day+series).
const flattenDaily = (daily) => {
  const out = [];
  for (const d of daily ?? []) {
    out.push({ Day: d.day, Tokens: d.input, Series: "Input" });
    out.push({ Day: d.day, Tokens: d.output, Series: "Output" });
  }
  return out;
};

const ProjectDetailPanel = ({ project, actions }) => (
  <Panel id={`project-detail-panel-${project.id}`} title={project.name} variant="modal">
    <PanelBody>
      <PanelSection>
        <DescriptionList direction="column">
          <DescriptionListItem label="Owner">
            {userLabel(project.ownerUserId, project.ownerName, project.ownerEmail)}
          </DescriptionListItem>
          <DescriptionListItem label="Chats">{String(project.chats)}</DescriptionListItem>
          <DescriptionListItem label="Tokens">{formatTokens(project.tokens)}</DescriptionListItem>
          <DescriptionListItem label="Cost">{formatCents(project.costMicroCents)}</DescriptionListItem>
          <DescriptionListItem label="Last active">
            {formatRelative(project.lastActive ?? project.updatedAt)}
          </DescriptionListItem>
        </DescriptionList>
      </PanelSection>
    </PanelBody>
    <PanelFooter>
      <Flex direction="column">
        <Button
          variant="secondary"
          onClick={() => actions.closeOverlay(`project-detail-panel-${project.id}`)}
        >
          Close
        </Button>
      </Flex>
    </PanelFooter>
  </Panel>
);

export const SettingsPage = () => {
  const { actions } = useExtensionApi();
  const { auth } = useProjects();

  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!BACKEND_ENABLED) {
      setIsLoading(false);
      setError({
        code: "backend_disabled",
        message: "Settings & usage requires the worker to be configured.",
      });
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    workerApi
      .getUsageSummary(auth, { window: "30d" })
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const header = (
    <Flex direction="column" gap="xs">
      <PageTitle>Studio settings & usage</PageTitle>
      <Text>
        Manage your HubSpot connection and see how the Studio assistant is
        spending tokens for this portal.
      </Text>
      <Flex direction="row" gap="sm">
        <Button
          variant="transparent"
          onClick={() => actions.navigateToPage({ to: "/" })}
        >
          <Icon name="left" /> Back to projects
        </Button>
      </Flex>
    </Flex>
  );

  if (isLoading) {
    return (
      <Flex direction="column" gap="md">
        {header}
        <Flex align="center" justify="center">
          <LoadingSpinner
            size="md"
            label="Loading usage…"
            showLabel={true}
            layout="centered"
          />
        </Flex>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex direction="column" gap="md">
        {header}
        <Alert variant="error" title="Couldn't load usage">
          <Text>
            {error.status ? `${error.status} ` : ""}
            {error.code || "error"}: {error.message || String(error)}
          </Text>
        </Alert>
      </Flex>
    );
  }

  if (!summary) {
    return (
      <Flex direction="column" gap="md">
        {header}
        <EmptyState title="No data yet" layout="vertical" imageName="components">
          <Text>Once someone runs a chat, usage will show up here.</Text>
        </EmptyState>
      </Flex>
    );
  }

  const { portal, overview, usage, team } = summary;

  return (
    <Flex direction="column" gap="md">
      {header}
      <Tabs defaultSelected="overview">
        <Tab tabId="overview" title="Overview">
          <OverviewTab portal={portal} overview={overview} auth={auth} />
        </Tab>
        <Tab tabId="usage" title="Usage">
          <UsageTab usage={usage} actions={actions} />
        </Tab>
        <Tab tabId="team" title="Team">
          <TeamTab team={team} />
        </Tab>
      </Tabs>
    </Flex>
  );
};

// ---------- Bring-your-own Anthropic key -----------------------------------
//
// Lets a portal store its own Anthropic API key (encrypted at rest on the
// worker) and pick which model chats run on, from the models that key can
// actually access. With a key connected, the beta credit gate is bypassed.
const AnthropicKeySection = ({ auth }) => {
  const [loading, setLoading] = useState(true);
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState([]);
  const [chatModel, setChatModel] = useState(null);
  const [keyError, setKeyError] = useState(null);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = () => {
    setLoading(true);
    workerApi
      .getAnthropicSettings(auth)
      .then((data) => {
        setHasKey(Boolean(data?.hasKey));
        setModels(data?.models ?? []);
        setChatModel(data?.chatModel ?? null);
        setKeyError(data?.keyError ?? null);
      })
      .catch((err) => setError(err?.message || "Couldn't load key settings."))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [auth]);

  const saveKey = () => {
    setBusy(true);
    setError(null);
    workerApi
      .setAnthropicKey(auth, draftKey.trim())
      .then((data) => {
        setHasKey(true);
        setModels(data?.models ?? []);
        setDraftKey("");
        setKeyError(null);
      })
      .catch((err) => setError(err?.message || "Anthropic rejected that key."))
      .finally(() => setBusy(false));
  };

  const removeKey = () => {
    setBusy(true);
    setError(null);
    workerApi
      .clearAnthropicKey(auth)
      .then(() => {
        setHasKey(false);
        setModels([]);
        setChatModel(null);
      })
      .catch((err) => setError(err?.message || "Couldn't remove the key."))
      .finally(() => setBusy(false));
  };

  const pickModel = (value) => {
    const next = value || null;
    setBusy(true);
    setError(null);
    workerApi
      .setChatModel(auth, next)
      .then((data) => setChatModel(data?.chatModel ?? null))
      .catch((err) => setError(err?.message || "Couldn't set the model."))
      .finally(() => setBusy(false));
  };

  const modelOptions = [
    { label: "Studio default (Claude Opus 4.8)", value: "" },
    ...models.map((m) => ({ label: m.displayName, value: `anthropic/${m.id}` })),
  ];

  return (
    <Tile>
      <Flex direction="column" gap="sm">
        <Flex direction="row" justify="between" align="center">
          <Text format={{ fontWeight: "demibold" }}>Bring your own Anthropic key</Text>
          {hasKey && (
            <StatusTag variant={keyError ? "warning" : "success"}>
              {keyError ? "Key needs attention" : "Key connected"}
            </StatusTag>
          )}
        </Flex>
        {loading ? (
          <LoadingSpinner size="sm" layout="centered" label="Loading key settings…" />
        ) : hasKey ? (
          <Flex direction="column" gap="sm">
            <Text variant="microcopy">
              Chats and design docs bill to your key, and the beta credit no
              longer applies. The key is stored encrypted and never shown again.
            </Text>
            {keyError && (
              <Alert title="Key check failed" variant="warning">
                {`${keyError}. Model choices may be stale — replace the key if this persists.`}
              </Alert>
            )}
            <Select
              label="Chat model"
              name="byok-chat-model"
              description="Models your key can access. Applies to new chats and design docs."
              options={modelOptions}
              value={chatModel ?? ""}
              onChange={pickModel}
              readOnly={busy}
            />
            <Flex direction="row" gap="sm">
              <Button variant="destructive" onClick={removeKey} disabled={busy}>
                Remove key
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Flex direction="column" gap="sm">
            <Text variant="microcopy">
              Add your own Anthropic API key to run Studio on your account —
              useful when the beta credit runs out. Stored encrypted on the
              server; never displayed after saving.
            </Text>
            <Input
              label="Anthropic API key"
              name="byok-key"
              placeholder="sk-ant-…"
              value={draftKey}
              onChange={setDraftKey}
              readOnly={busy}
            />
            <Flex direction="row" gap="sm">
              <Button
                variant="primary"
                onClick={saveKey}
                disabled={busy || !draftKey.trim().startsWith("sk-ant-")}
              >
                {busy ? "Verifying…" : "Connect key"}
              </Button>
            </Flex>
          </Flex>
        )}
        {error && (
          <Alert title="Something went wrong" variant="danger">
            {error}
          </Alert>
        )}
      </Flex>
    </Tile>
  );
};

// ---------- Overview tab ---------------------------------------------------

const OverviewTab = ({ portal, overview, auth }) => {
  const tokens30d = overview.tokens30d;
  const credit = portal.creditMicroCents ?? 0;
  const spend = portal.spendMicroCents ?? 0;
  const remaining = Math.max(credit - spend, 0);
  const pctUsed = credit > 0 ? Math.min((spend / credit) * 100, 100) : 0;
  // Color the bar by how close we are to the cap. >=90% reads as danger,
  // >=70% as warning, otherwise green.
  const creditVariant =
    pctUsed >= 90 ? "danger" : pctUsed >= 70 ? "warning" : "success";
  return (
    <Flex direction="column" gap="md">
      <Statistics>
        <StatisticsItem
          label="Projects"
          number={String(overview.projects)}
          sublabel={`${overview.projectsCreatedThisMonth} created this month`}
        />
        <StatisticsItem
          label="Chats"
          number={String(overview.chats)}
          sublabel={`${overview.chatsLast7d} in the last 7 days`}
        />
        <StatisticsItem
          label="Tokens (30d)"
          number={formatTokens(tokens30d.total)}
          sublabel={`${formatTokens(tokens30d.input)} in · ${formatTokens(tokens30d.output)} out`}
        />
        <StatisticsItem
          label="Spend (30d)"
          number={formatCents(overview.costMicroCents30d)}
          sublabel="Est. Anthropic cost"
        />
      </Statistics>

      {credit > 0 && (
        <Flex direction="column" gap="xs">
          <ProgressBar
            title="Beta credit"
            value={Math.min(spend, credit)}
            maxValue={credit}
            valueDescription={`${formatCents(spend)} of ${formatCents(credit)} used · ${formatCents(remaining)} left`}
            variant={creditVariant}
            showPercentage
          />
          {remaining === 0 && (
            <Text variant="microcopy">
              Credit exhausted — new chats are blocked. Add your own Anthropic
              key below to keep going, or reach out to me@cartermckay.com to
              top up.
            </Text>
          )}
        </Flex>
      )}

      <AnthropicKeySection auth={auth} />

      <Tile>
        <Flex direction="column" gap="sm">
          <Text format={{ fontWeight: "demibold" }}>
            {`Hub ${portal.hubId}`}
          </Text>
          <DescriptionList direction="row">
            <DescriptionListItem label="Hub ID">
              {String(portal.hubId)}
            </DescriptionListItem>
            <DescriptionListItem label="Auth user">
              {userLabel(portal.authUserId, portal.authUserName, portal.authUserEmail)}
            </DescriptionListItem>
            <DescriptionListItem label="Installed">
              {formatRelative(portal.installedAt)}
            </DescriptionListItem>
            <DescriptionListItem label="Connection">
              <StatusTag variant={portal.connectionStatusVariant}>
                {portal.connectionStatusLabel}
              </StatusTag>
            </DescriptionListItem>
          </DescriptionList>
        </Flex>
      </Tile>

      <Tile>
        {overview.lastChat ? (
          <Flex direction="row" align="center" gap="sm">
            <Text variant="microcopy">Last chat</Text>
            <Text format={{ fontWeight: "demibold" }}>
              {formatRelative(overview.lastChat.updatedAt)}
            </Text>
            <Text variant="microcopy">·</Text>
            <Text>{overview.lastChat.projectName}</Text>
          </Flex>
        ) : (
          <Text variant="microcopy">No chats yet.</Text>
        )}
      </Tile>
    </Flex>
  );
};

// ---------- Usage tab ------------------------------------------------------

const UsageTab = ({ usage, actions }) => {
  const dailyRows = useMemo(() => flattenDaily(usage.daily), [usage.daily]);
  const sublabelForWindow = "Last 30 days";

  return (
    <Flex direction="column" gap="md">
      <Statistics>
        <StatisticsItem
          label="Input tokens"
          number={formatTokens(usage.inputTokens)}
          sublabel={sublabelForWindow}
        />
        <StatisticsItem
          label="Output tokens"
          number={formatTokens(usage.outputTokens)}
          sublabel={sublabelForWindow}
        />
        <StatisticsItem
          label="Total cost"
          number={formatCents(usage.costMicroCents)}
          sublabel="Est. Anthropic cost"
        />
        <StatisticsItem
          label="Avg turn latency"
          number={formatLatency(usage.avgLatencyMs)}
          sublabel={
            usage.p95LatencyMs != null
              ? `P95: ${formatLatency(usage.p95LatencyMs)}`
              : `${usage.sampleSize} samples`
          }
        />
      </Statistics>

      <Tile>
        <Flex direction="column" gap="sm">
          <Text format={{ fontWeight: "demibold" }}>Daily token volume</Text>
          <Text variant="microcopy">Input vs. output tokens by day</Text>
          {dailyRows.length === 0 ? (
            <Text variant="microcopy">No usage in this window.</Text>
          ) : (
            <LineChart
              data={dailyRows}
              axes={{
                x: { field: "Day", fieldType: "category" },
                y: { field: "Tokens", fieldType: "linear" },
                options: { groupFieldByColor: "Series" },
              }}
              options={{ showLegend: true, showTooltips: true }}
            />
          )}
        </Flex>
      </Tile>

      <Tile>
        <Flex direction="column" gap="sm">
          <Text format={{ fontWeight: "demibold" }}>Usage by project</Text>
          {usage.projectUsage.length === 0 ? (
            <Text variant="microcopy">No projects yet.</Text>
          ) : (
            <DataTable
              data={usage.projectUsage}
              searchFields={["name"]}
              pageSize={10}
              columns={[
                {
                  field: "name",
                  label: "Project",
                  renderCell: (value, row) => (
                    <Link overlay={<ProjectDetailPanel project={row} actions={actions} />}>
                      {value}
                    </Link>
                  ),
                },
                { field: "chats", label: "Chats", sortable: true, width: "auto" },
                {
                  field: "tokens",
                  label: "Tokens",
                  sortable: true,
                  width: "auto",
                  renderCell: (value) => formatTokens(value),
                },
                {
                  field: "costMicroCents",
                  label: "Cost",
                  sortable: true,
                  width: "auto",
                  renderCell: (value) => formatCents(value),
                },
                {
                  field: "deltaPercent",
                  label: "Trend",
                  description:
                    "% change in tokens over the last 30 days vs. the prior 30 days. \"New\" means the project had no usage in the prior window.",
                  width: "auto",
                  renderCell: (_value, row) => (
                    <StatusTag variant={deltaVariant(row.deltaPercent)}>
                      {deltaLabel(row.deltaPercent, row.isNew)}
                    </StatusTag>
                  ),
                },
                {
                  field: "lastActive",
                  label: "Last active",
                  width: "auto",
                  renderCell: (value, row) =>
                    formatRelative(value ?? row.updatedAt),
                },
              ]}
            />
          )}
        </Flex>
      </Tile>
    </Flex>
  );
};

// ---------- Team tab -------------------------------------------------------

const TeamTab = ({ team }) => {
  // Busiest user / most projects summaries derived from the rows.
  const busiest = useMemo(() => {
    if (!team.rows.length) return null;
    return [...team.rows].sort((a, b) => b.tokens - a.tokens)[0];
  }, [team.rows]);
  const mostProjects = useMemo(() => {
    if (!team.rows.length) return null;
    return [...team.rows].sort((a, b) => b.projects - a.projects)[0];
  }, [team.rows]);

  const tokenByUser = useMemo(
    () =>
      team.rows.map((r) => ({
        User: userLabel(r.userId, r.userName, r.userEmail),
        Tokens: r.tokens,
      })),
    [team.rows],
  );
  const spendByUser = useMemo(
    () =>
      team.rows.map((r) => ({
        User: userLabel(r.userId, r.userName, r.userEmail),
        // Chart expects numeric dollar amounts. micro_cents → dollars.
        Spend: Number((r.costMicroCents / 100_000).toFixed(4)),
      })),
    [team.rows],
  );

  const leaderboard = useMemo(
    () =>
      team.rows.map((r) => ({
        user: userLabel(r.userId, r.userName, r.userEmail),
        projects: r.projects,
        tokens: r.tokens,
        costMicroCents: r.costMicroCents,
        sharePercent:
          team.totalTokens > 0
            ? Math.round((r.tokens / team.totalTokens) * 100)
            : 0,
        lastActive: r.lastActive,
      })),
    [team.rows, team.totalTokens],
  );

  return (
    <Flex direction="column" gap="md">
      <Statistics>
        <StatisticsItem
          label="Active teammates"
          number={String(team.activeTeammates)}
          sublabel={`of ${team.totalTeammates} with projects`}
        />
        <StatisticsItem
          label="Busiest user"
          number={busiest ? userLabel(busiest.userId, busiest.userName, busiest.userEmail) : "—"}
          sublabel={
            busiest ? `${formatTokens(busiest.tokens)} tokens in window` : ""
          }
        />
        <StatisticsItem
          label="Most projects"
          number={mostProjects ? userLabel(mostProjects.userId, mostProjects.userName, mostProjects.userEmail) : "—"}
          sublabel={
            mostProjects ? `${mostProjects.projects} owned project(s)` : ""
          }
        />
      </Statistics>

      <Tile>
        <Flex direction="column" gap="sm">
          <Text format={{ fontWeight: "demibold" }}>Token spend by user</Text>
          <Text variant="microcopy">
            Attributed to project owner · selected window
          </Text>
          {tokenByUser.length === 0 ? (
            <Text variant="microcopy">No team usage in this window.</Text>
          ) : (
            <BarChart
              data={tokenByUser}
              axes={{
                x: { field: "User", fieldType: "category" },
                y: { field: "Tokens", fieldType: "linear" },
              }}
              options={{ showLegend: false, showTooltips: true }}
            />
          )}
          <Text format={{ fontWeight: "demibold" }}>Estimated spend (USD)</Text>
          {spendByUser.length === 0 ? (
            <Text variant="microcopy">—</Text>
          ) : (
            <BarChart
              data={spendByUser}
              axes={{
                x: { field: "User", fieldType: "category" },
                y: { field: "Spend", fieldType: "linear" },
              }}
              options={{ showLegend: false, showTooltips: true }}
            />
          )}
        </Flex>
      </Tile>

      <Tile>
        <Flex direction="column" gap="sm">
          <Text format={{ fontWeight: "demibold" }}>Team leaderboard</Text>
          {leaderboard.length === 0 ? (
            <Text variant="microcopy">No team activity yet.</Text>
          ) : (
            <DataTable
              data={leaderboard}
              pageSize={10}
              columns={[
                { field: "user", label: "User", sortable: true, width: "min" },
                {
                  field: "projects",
                  label: "Projects",
                  sortable: true,
                  width: "min",
                },
                {
                  field: "tokens",
                  label: "Tokens",
                  sortable: true,
                  width: "min",
                  renderCell: (value) => formatTokens(value),
                },
                {
                  field: "costMicroCents",
                  label: "Cost",
                  sortable: true,
                  width: "min",
                  renderCell: (value) => formatCents(value),
                },
                {
                  field: "sharePercent",
                  label: "Share %",
                  sortable: true,
                  width: "min",
                  renderCell: (value) => `${value}%`,
                },
                {
                  field: "lastActive",
                  label: "Last active",
                  width: "min",
                  renderCell: (value) => formatRelative(value),
                },
              ]}
            />
          )}
        </Flex>
      </Tile>
    </Flex>
  );
};
