// repairSpec — walks a model-produced spec and fixes the silent-drop traps
// we keep hitting:
//
//   - Icon nodes with invalid `name` (platform renders empty) — auto-map
//     common aliases (`duplicate`→`copy`, `alert`→`warning`, …) or rewrite
//     to a visible `xCircle` placeholder with screenReaderText so it's
//     obvious in the UI.
//   - EmptyState nodes with invalid `imageName` (platform throws) — fall
//     back to "components" (or a closer alias).
//
// Mutates the spec in place for minimal churn — validateSpec and the
// renderer both walk the same object. Returns the list of repairs so the
// turn can surface them to the author ("I replaced 2 bad icon names").
//
// The mirror of this lives client-side in
// apps/studio-app/src/app/pages/renderer/catalogs.js; keep both in sync
// when the SDK adds icon/image names.

export interface SpecRepair {
  path: string;
  kind:
    | "icon-alias"
    | "icon-invalid"
    | "image-alias"
    | "image-invalid"
    | "trend-direction-alias";
  original: string;
  replacement: string;
}

export const TREND_DIRECTIONS = new Set(["increase", "decrease"]);
export const TREND_DIRECTION_ALIASES: Record<string, string> = {
  increasing: "increase",
  decreasing: "decrease",
  up: "increase",
  down: "decrease",
  positive: "increase",
  negative: "decrease",
};

export interface RepairResult {
  warnings: SpecRepair[];
}

export const ICON_NAMES = new Set([
  "add","appointment","approvals","artificialIntelligence",
  "artificialIntelligenceEnhanced","attach","bank","block","book","bulb",
  "callTranscript","calling","callingHangup","callingMade","callingMissed",
  "callingVoicemail","campaigns","cap","checkCircle","circleFilled",
  "circleHollow","clock","comment","contact","copy","crm","dataSync","date",
  "delay","delete","description","developerProjects","documents","downCarat",
  "download","edit","ellipses","email","emailOpen","emailThreadedReplies",
  "enrichment","enroll","exclamation","exclamationCircle","faceHappy",
  "faceHappyFilled","faceNeutral","faceNeutralFilled","faceSad",
  "faceSadFilled","facebook","favoriteHollow","file","filledXCircleIcon",
  "filter","flame","folder","folderOpen","forward","gauge","generateChart",
  "gift","globe","globeLine","goal","googlePlus","guidedActions","hash",
  "hide","home","hubDB","image","imageGallery","inbox","info","infoNoCircle",
  "insertVideo","instagram","integrations","invoice","key","language","left",
  "lessCircle","lesson","light","link","linkedin","listView","location",
  "locked","mention","messages","mobile","moreCircle","notEditable",
  "notification","notificationOff","objectAssociations",
  "objectAssociationsManyToMany","objectAssociationsManyToOne","office365",
  "order","paymentSubscriptions","pin","pinterest","powerPointFile",
  "presentation","product","publish","question","questionAnswer",
  "questionCircle","quickbooks","quote","readMore","readOnlyView",
  "realEstateListing","recentlySelected","record","redo","refresh",
  "registration","remove","replace","reports","right","robot","rotate","rss",
  "salesQuote","salesTemplates","save","search","send","sequences","settings",
  "shoppingCart","signal","signalPoor","signature","snooze","sortAlpAsc",
  "sortAlpDesc","sortAmtAsc","sortAmtDesc","sortNumAsc","sortNumDesc",
  "sortTableAsc","sortTableDesc","spellCheck","sprocket","star","stopRecord",
  "strike","styles","success","tablet","tag","tasks","test","text",
  "textBodyExpanded","textColor","textDataType","textSnippet","thumbsDown",
  "thumbsUp","ticket","translate","trophy","twitter","undo","upCarat","upload",
  "video","videoFile","videoPlayerSubtitles","view","viewDetails","warning",
  "website","workflows","x","xCircle","xing","youtube","youtubePlay","zoomIn",
  "zoomOut",
]);

export const ICON_NAME_ALIASES: Record<string, string> = {
  alert: "warning",
  check: "success",
  checkmark: "success",
  danger: "xCircle",
  duplicate: "copy",
  error: "xCircle",
  trash: "delete",
  pencil: "edit",
  arrowLeft: "left",
  arrowRight: "right",
  arrowUp: "upCarat",
  arrowDown: "downCarat",
  cog: "settings",
  gear: "settings",
  close: "xCircle",
  plus: "add",
  minus: "remove",
  ok: "success",
};

export const EMPTY_STATE_IMAGES = new Set([
  "addOnReporting","announcement","api","automatedTesting","beta","building",
  "callingSetUp","companies","components","cone","contacts","contentStrategy",
  "customObjects","customerExperience","customerSupport","deals",
  "developerSecurityUpdate","electronicSignature",
  "electronicSignatureEmptyState","emailConfirmation","emptyStateCharts",
  "idea","integrations","leads","lock","missedGoal","multipleObjects","object",
  "productsShoppingCart","registration","sandboxAddOn","social","store",
  "storeDisabled","successfullyConnectedEmail","target","task","voteAndSearch",
  "meetings","tickets",
]);

export const EMPTY_STATE_IMAGE_ALIASES: Record<string, string> = {
  "new-project": "components",
  newProject: "components",
  empty: "components",
  default: "components",
};

export function repairSpec(spec: unknown): RepairResult {
  const warnings: SpecRepair[] = [];
  if (!isObject(spec)) return { warnings };

  // v1 adjacency-list: walk `elements`. Also traverse inline nodes under
  // $forEach.render and $render.node so we catch icons embedded in loops.
  const elements =
    isObject((spec as Record<string, unknown>).elements)
      ? ((spec as Record<string, unknown>).elements as Record<string, unknown>)
      : null;
  if (elements) {
    for (const [id, node] of Object.entries(elements)) {
      if (isObject(node)) {
        walk(node as Record<string, unknown>, `$.elements["${id}"]`, warnings);
      }
    }
  }

  // v0 fallback: spec has a `root` object rather than an ID.
  const root = (spec as Record<string, unknown>).root;
  if (isObject(root)) {
    walk(root as Record<string, unknown>, "$.root", warnings);
  }

  return { warnings };
}

function walk(node: Record<string, unknown>, path: string, warnings: SpecRepair[]): void {
  if ("$forEach" in node && isObject(node.render)) {
    walk(node.render as Record<string, unknown>, `${path}.render`, warnings);
  }
  if ("$render" in node && isObject((node as { node?: unknown }).node)) {
    walk(
      (node as { node: Record<string, unknown> }).node,
      `${path}.node`,
      warnings,
    );
  }

  if (node.type === "Icon") {
    repairIcon(node, path, warnings);
  } else if (node.type === "EmptyState") {
    repairEmptyState(node, path, warnings);
  } else if (node.type === "StatisticsTrend") {
    repairTrendDirection(node, path, warnings);
  }

  // Recurse into children (array | object | string — string is a text
  // leaf or an element ID, neither needs walking here).
  const children = node.children;
  if (Array.isArray(children)) {
    children.forEach((child, i) => {
      if (isObject(child)) {
        walk(child as Record<string, unknown>, `${path}.children[${i}]`, warnings);
      }
    });
  } else if (isObject(children)) {
    walk(children as Record<string, unknown>, `${path}.children`, warnings);
  }

  // Some components nest action descriptors or overlay panels in arbitrary
  // prop positions (Link.overlay, Button.overlay). Walk every object-valued
  // prop too so we repair inline icons/empty-states wherever they live.
  for (const [key, val] of Object.entries(node)) {
    if (
      key === "children" ||
      key === "render" ||
      key === "node" ||
      key === "type" ||
      key === "visible"
    )
      continue;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (isObject(v)) walk(v as Record<string, unknown>, `${path}.${key}[${i}]`, warnings);
      });
    } else if (isObject(val)) {
      walk(val as Record<string, unknown>, `${path}.${key}`, warnings);
    }
  }
}

function repairIcon(
  node: Record<string, unknown>,
  path: string,
  warnings: SpecRepair[],
): void {
  const name = node.name;
  // Missing `name` is just as broken as an invalid one — the platform
  // renders nothing. Surface it the same way: xCircle placeholder +
  // warning so the model sees it and adds a proper name next turn.
  if (name === undefined || name === null || name === "") {
    node.name = "xCircle";
    if (typeof node.screenReaderText !== "string") {
      node.screenReaderText = "Icon missing name prop";
    }
    if (node.color !== "warning") node.color = "alert";
    warnings.push({
      path,
      kind: "icon-invalid",
      original: "(missing)",
      replacement: "xCircle",
    });
    return;
  }
  if (typeof name !== "string") return;
  if (ICON_NAMES.has(name)) return;
  const alias = ICON_NAME_ALIASES[name];
  if (alias && ICON_NAMES.has(alias)) {
    node.name = alias;
    warnings.push({
      path,
      kind: "icon-alias",
      original: name,
      replacement: alias,
    });
    return;
  }
  // Replace with a visible placeholder so the author notices. Preserve the
  // original name in screenReaderText as a breadcrumb.
  node.name = "xCircle";
  if (typeof node.screenReaderText !== "string") {
    node.screenReaderText = `Invalid icon: ${name}`;
  }
  if (node.color !== "warning") node.color = "alert";
  warnings.push({
    path,
    kind: "icon-invalid",
    original: name,
    replacement: "xCircle",
  });
}

function repairEmptyState(
  node: Record<string, unknown>,
  path: string,
  warnings: SpecRepair[],
): void {
  const imageName = node.imageName;
  if (typeof imageName !== "string") return;
  if (EMPTY_STATE_IMAGES.has(imageName)) return;
  const alias = EMPTY_STATE_IMAGE_ALIASES[imageName];
  const replacement =
    alias && EMPTY_STATE_IMAGES.has(alias) ? alias : "components";
  node.imageName = replacement;
  warnings.push({
    path,
    kind: alias ? "image-alias" : "image-invalid",
    original: imageName,
    replacement,
  });
}

function repairTrendDirection(
  node: Record<string, unknown>,
  path: string,
  warnings: SpecRepair[],
): void {
  const direction = node.direction;
  if (typeof direction !== "string") return;
  if (TREND_DIRECTIONS.has(direction)) return;
  const alias = TREND_DIRECTION_ALIASES[direction];
  if (alias && TREND_DIRECTIONS.has(alias)) {
    node.direction = alias;
    warnings.push({
      path,
      kind: "trend-direction-alias",
      original: direction,
      replacement: alias,
    });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
