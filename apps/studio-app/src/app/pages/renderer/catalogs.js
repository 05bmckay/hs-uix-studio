// Authoritative allowlists for enum-like props that the platform silently
// drops on invalid values. Generated once from:
//   node_modules/@hubspot/ui-extensions/dist/shared/types/shared.js
// and the error message the platform surfaces for bad EmptyState imageName.
//
// Keep these in sync with the installed SDK version. They only need bumping
// when @hubspot/ui-extensions adds new members.

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

// Common mistakes from generators → the nearest valid icon name. Applied
// silently with a console.warn so the model's intent still renders.
export const ICON_NAME_ALIASES = {
  alert: "warning",          // "alert" is a color, not an icon
  check: "success",
  checkmark: "success",
  danger: "xCircle",         // "danger" is a StatusTag variant
  duplicate: "copy",
  error: "xCircle",          // "error" is a Tag variant, not an icon
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

// EmptyState imageName catalog (same "silently invalid" trap — surface
// shows "errorImageName is not valid" but the platform still crashes
// rendering).
export const EMPTY_STATE_IMAGES = new Set([
  "addOnReporting","announcement","api","automatedTesting","beta","building",
  "callingSetUp","companies","components","cone","contacts","contentStrategy",
  "customObjects","customerExperience","customerSupport","deals",
  "developerSecurityUpdate","electronicSignature","electronicSignatureEmptyState",
  "emailConfirmation","emptyStateCharts","idea","integrations","leads","lock",
  "missedGoal","multipleObjects","object","productsShoppingCart","registration",
  "sandboxAddOn","social","store","storeDisabled","successfullyConnectedEmail",
  "target","task","voteAndSearch","meetings","tickets",
]);

export const EMPTY_STATE_IMAGE_ALIASES = {
  "new-project": "components",
  newProject: "components",
  empty: "components",
  default: "components",
};

// StatisticsTrend.direction accepts only "increase" | "decrease". The
// generator keeps reaching for present-participle forms.
export const TREND_DIRECTIONS = new Set(["increase", "decrease"]);
export const TREND_DIRECTION_ALIASES = {
  increasing: "increase",
  decreasing: "decrease",
  up: "increase",
  down: "decrease",
  positive: "increase",
  negative: "decrease",
};
