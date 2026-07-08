(() => {
const FORGE_LS_KEY = 'bw-build-order';
const MIN_DUR = 300;
const WIGGLE = 120;
const GAS_GRAPH_H = 132;
const GAS_PADDING_X = 8;
const GAS_PADDING_Y = 14;
const COMBAT_BUCKET_SECS = 5;
const SUPPLY_GAP_MERGE_SECS = 5;
const TERMINAL_DEATH_WINDOW_SECS = 5;
const TERMINAL_DEATH_MIN_COUNT = 8;
const TERMINAL_DEATH_MIN_FRACTION = 0.2;
const ZERG_CONSTRUCTION_DRONE_MATCH_WINDOW_SECS = 1.5;
const COMBAT_BODY_MIN_HEIGHT = 96;
const COMBAT_BODY_DEFAULT_HEIGHT = 188;
let sets = [];
let activeSetId = null;
let nextItemId = 0;
let nextSetId = 1;
let selectedIds = new Set();
let dragState = null;
let combatPanelExpanded = false;
let syncingPanelScroll = false;
let assetPanelCollapsed = false;
let boPanelCollapsed = false;
let showUnits = false;
let showCombatWorkers = true;
let showCombatUnits = true;
let showCombatBuildings = true;
let combatBodyHeight = COMBAT_BODY_DEFAULT_HEIGHT;
let combatResizeState = null;
let boExpandedWidth = '';

const appEl = document.getElementById('app');
const analysisStatusEl = document.getElementById('analysis-status');
const analysisCopyWrapEl = document.getElementById('analysis-copy-wrap');
const analysisCopyBtnEl = document.getElementById('analysis-copy-btn');
const analysisCopyFullBtnEl = document.getElementById('analysis-copy-full-btn');
const analysisCopyPromptBtnEl = document.getElementById('analysis-copy-prompt-btn');
const importPlayerDataBtn = document.getElementById('import-player-data-btn');
const clearDataBtn = document.getElementById('clear-data-btn');
const boSectionEl = document.getElementById('bo-section');
const ghostEl = document.getElementById('ghost');
const tipEl = document.getElementById('tip');
const ctxEl = document.getElementById('ctx');
const boText = document.getElementById('bo-text');
const boHintEl = document.getElementById('bo-hint');
const boHeaderEl = document.getElementById('bo-header');
const boMoreWrapEl = document.getElementById('bo-more-wrap');
const boMoreBtnEl = document.getElementById('bo-more-btn');
const boImportBtnEl = document.getElementById('bo-import-btn');
const boRenameBtnEl = document.getElementById('bo-rename-btn');
const boRemovePlayerBtnEl = document.getElementById('bo-remove-player-btn');
const boCopyBtnEl = document.getElementById('bo-copy-btn');
const boTableWrapEl = document.getElementById('bo-table-wrap');
const boTableEl = document.getElementById('bo-table');
const boTableBodyEl = document.getElementById('bo-table-body');
const boEmptyEl = document.getElementById('bo-empty');
const boImportModalEl = document.getElementById('bo-import-modal');
const boImportBackdropEl = document.getElementById('bo-import-backdrop');
const boImportCloseBtnEl = document.getElementById('bo-import-close-btn');
const boImportCancelBtnEl = document.getElementById('bo-import-cancel-btn');
const boImportApplyBtnEl = document.getElementById('bo-import-apply-btn');
const labelList = document.getElementById('label-list');
const tracksRoot = document.getElementById('tracks');
const ruler = document.getElementById('ruler');
const tlInner = document.getElementById('tl-inner');
const tlScroll = document.getElementById('tl-scroll');
const timelineEmptyEl = document.getElementById('timeline-empty');
const timelineHoverLine = document.getElementById('timeline-hover-line');
const timelineHoverLabel = document.getElementById('timeline-hover-label');
const boTitle = document.getElementById('bo-title');
const hiddenSupply = document.getElementById('supply-row');
const hiddenLabelSupply = document.getElementById('label-supply-cell');
const gasPanelEl = document.getElementById('gas-panel');
const gasToggleBtn = document.getElementById('gas-toggle-btn');
const combatPanelEl = document.getElementById('combat-panel');
const combatResizeHandleEl = document.getElementById('combat-resize-handle');
const combatToggleBtn = document.getElementById('combat-toggle-btn');
const combatSubtitleEl = document.getElementById('combat-subtitle');
const combatBodyEl = document.getElementById('combat-body');
const combatLabelSectionsEl = document.getElementById('combat-label-sections');
const combatScrollEl = document.getElementById('combat-scroll');
const combatInnerEl = document.getElementById('combat-inner');
const combatEmptyEl = document.getElementById('combat-empty');
const combatSectionsEl = document.getElementById('combat-sections');
const combatCopyWrapEl = document.getElementById('combat-copy-wrap');
const combatCopyBtnEl = document.getElementById('combat-copy-btn');
const combatCopyFocusedBtnEl = document.getElementById('combat-copy-focused-btn');
const combatCopyAllBtnEl = document.getElementById('combat-copy-all-btn');
const combatWorkersBtn = document.getElementById('combat-workers-btn');
const combatUnitsBtn = document.getElementById('combat-units-btn');
const combatBuildingsBtn = document.getElementById('combat-buildings-btn');
const assetToggleBtn = document.getElementById('asset-toggle-btn');
const boToggleBtn = document.getElementById('bo-toggle-btn');
const boHeaderActionsEl = document.getElementById('bo-header-actions');
const downloadReplayBtn = document.getElementById('download-replay-btn');
const searchBoxEl = document.getElementById('search-box');
const timelineZoomOutBtn = document.getElementById('timeline-zoom-out-btn');
const timelineZoomInBtn = document.getElementById('timeline-zoom-in-btn');
const unitToggleBtn = document.getElementById('unit-toggle-btn');
const timelineSubtitleEl = document.getElementById('timeline-subtitle');
const gasSubtitleEl = document.getElementById('gas-subtitle');
const gasScrollEl = document.getElementById('gas-scroll');
const gasInnerEl = document.getElementById('gas-inner');
const gasSvgEl = document.getElementById('gas-svg');
const gasEmptyEl = document.getElementById('gas-empty');
const bundleFileInput = document.getElementById('bundle-file');
let boPlayerSelectEl = null;
let combatHoverUpdate = null;
let combatHoverClear = null;
let embeddedReplayName = null;
let embeddedReplayUrl = null;
let embeddedPageTitle = null;
const ANALYSIS_REPORT_SEPARATOR = '==============================';
const COMBAT_LEDGER_CHECKPOINTS = [180, 240, 300, 360, 420, 480, 600, 720];
const COMBAT_WINDOW_GAP_SECS = 15;
const COMBAT_LEDGER_SEPARATOR = '==============================';
const COMBAT_STRATEGIC_MILESTONE_TYPES = new Set([
  'scv', 'probe', 'drone',
  'marine', 'medic', 'vulture', 'siege_tank', 'goliath',
  'zealot', 'dragoon', 'dark_templar', 'high_templar', 'reaver', 'shuttle', 'observer',
  'zergling', 'hydralisk', 'lurker', 'mutalisk', 'scourge', 'defiler', 'ultralisk',
  'hatchery', 'lair', 'hive', 'nexus', 'command_center',
]);

// Key pressing management
const keysDown = new Set();
window.addEventListener('keydown', (e) => {
  keysDown.add(e.code);
});

window.addEventListener('keyup', (e) => {
  keysDown.delete(e.code);
});

function isKeyHeld(code) {
  return keysDown.has(code);
}
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function formatRounded(value) {
  return Math.round(Number.isFinite(value) ? value : 0);
}
function titleizeUnitType(value) {
  return String(value || '')
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
function normalizeUnitTypeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function pluralizeUnitLabel(label, count) {
  if (count === 1) return label;
  if (label.endsWith('s')) return label;
  return label + 's';
}
const deathCostByUnitType = new Map(
  (typeof DATA !== 'undefined' ? DATA : []).map(item => ([
    normalizeUnitTypeKey(item.name),
    {
      mineralCost: Number.isFinite(item.mineralCost) ? item.mineralCost : 0,
      gasCost: Number.isFinite(item.gasCost) ? item.gasCost : 0,
    },
  ])),
);
const deathDisplayNameByUnitType = new Map(
  (typeof DATA !== 'undefined' ? DATA : []).map(item => ([
    normalizeUnitTypeKey(item.name),
    item.name,
  ])),
);
function getDeathCost(unitType) {
  return deathCostByUnitType.get(normalizeUnitTypeKey(unitType)) || { mineralCost: 0, gasCost: 0 };
}
function getDeathDisplayName(unitType) {
  const normalized = normalizeUnitTypeKey(unitType);
  return deathDisplayNameByUnitType.get(normalized) || titleizeUnitType(normalized);
}
function renderCombatCumulativeTooltip(entries, time) {
  return entries.map(entry => {
    const countsByUnit = new Map();
    let mineralsLost = 0;
    let gasLost = 0;
    let totalLost = 0;
    entry.samples.forEach(sample => {
      if (sample.time_seconds > time) return;
      if (!deathCategoryLane(sample.category)) return;
      const key = sample.unit_type || 'unknown';
      countsByUnit.set(key, (countsByUnit.get(key) || 0) + 1);
      const cost = getDeathCost(key);
      mineralsLost += cost.mineralCost;
      gasLost += cost.gasCost;
      totalLost += 1;
    });
    const lines = [...countsByUnit.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([unitType, count]) => {
        const label = pluralizeUnitLabel(getDeathDisplayName(unitType), count);
        return `<li>${count} ${escapeHtml(label)}</li>`;
      })
      .join('');
    const listHtml = lines
      ? `<ul class="timeline-hover-army">${lines}</ul>`
      : '<div class="timeline-hover-empty">No losses yet</div>';
    const metaText = entry.set.playerData && entry.set.playerData.race
      ? `${entry.set.playerData.race} cumulative losses`
      : 'Cumulative losses';
    return `<div class="timeline-hover-player-col">`
      + `<div class="timeline-hover-heading"><strong>${escapeHtml(entry.set.name)}</strong><span class="timeline-hover-time">${fmt(Math.round(time))}</span></div>`
      + `<div class="timeline-hover-meta">${escapeHtml(metaText)}</div>`
      + `<div class="timeline-hover-statline"><span class="timeline-hover-icon">Total</span> ${formatRounded(totalLost)}</div>`
      + `<div class="timeline-hover-statline"><span class="timeline-hover-icon">🔷</span> ${formatRounded(mineralsLost)} <span class="timeline-hover-icon">🟩</span> ${formatRounded(gasLost)}</div>`
      + `${listHtml}`
      + `</div>`;
  }).join('');
}
function currentPageTitle() {
  if (embeddedPageTitle) return embeddedPageTitle;
  const set = activeSet();
  return set ? set.name : 'Brood War Build Analysis';
}
function applyPageTitle(title) {
  embeddedPageTitle = typeof title === 'string' && title.trim() ? title.trim() : null;
  const resolved = currentPageTitle();
  document.title = resolved;
}
function ensureSidebarPlayerSelector() {
  if (!boHintEl) return;
  if (!boPlayerSelectEl) {
    boHintEl.innerHTML = '<span id="bo-player-label">Player:</span><select id="bo-player-select" aria-label="Focused player"></select>';
    boPlayerSelectEl = document.getElementById('bo-player-select');
    if (boPlayerSelectEl) {
      boPlayerSelectEl.addEventListener('change', event => {
        const nextId = Number(event.target.value);
        if (!Number.isFinite(nextId)) return;
        window.switchActiveTrackSet(nextId);
      });
    }
  }
}
function renderAnalysisStatus() {
  if (!analysisStatusEl) return;
  if (!sets.length) {
    analysisStatusEl.textContent = embeddedReplayUrl
      ? 'No analysis data loaded. Original replay available.'
      : 'No analysis data loaded.';
    return;
  }
  const sourceLabel = analysisSourceLabel(sets, false);
  const playerLabel = `${sets.length} ${sets.length === 1 ? 'player' : 'players'}`;
  analysisStatusEl.textContent = embeddedReplayUrl
    ? `${sourceLabel} | ${playerLabel} | Original replay available`
    : `${sourceLabel} | ${playerLabel}`;
}
function syncFocusedPlayerUi() {
  ensureSidebarPlayerSelector();
  const set = activeSet();
  if (boTitle) boTitle.textContent = 'Build Order';
  if (!boPlayerSelectEl) return;
  boPlayerSelectEl.innerHTML = '';
  if (!sets.length) {
    const option = document.createElement('option');
    option.textContent = 'No player loaded';
    option.value = '';
    boPlayerSelectEl.appendChild(option);
    boPlayerSelectEl.disabled = true;
    return;
  }
  sets.forEach(entry => {
    const option = document.createElement('option');
    option.value = String(entry.id);
    option.textContent = entry.name;
    if (entry.id === activeSetId) option.selected = true;
    boPlayerSelectEl.appendChild(option);
  });
  boPlayerSelectEl.disabled = false;
}
function closeBoMoreMenu() {
  if (!boMoreWrapEl || !boMoreBtnEl) return;
  boMoreWrapEl.classList.remove('open');
  boMoreBtnEl.setAttribute('aria-expanded', 'false');
}
function closeAnalysisCopyMenu() {
  if (!analysisCopyWrapEl || !analysisCopyBtnEl) return;
  analysisCopyWrapEl.classList.remove('open');
  analysisCopyBtnEl.setAttribute('aria-expanded', 'false');
}
function closeCombatCopyMenu() {
  if (!combatCopyWrapEl || !combatCopyBtnEl) return;
  combatCopyWrapEl.classList.remove('open');
  combatCopyBtnEl.setAttribute('aria-expanded', 'false');
}
function bindStaticUiActions() {
  if (downloadReplayBtn) {
    downloadReplayBtn.addEventListener('click', () => window.downloadEmbeddedReplay());
  }
  if (clearDataBtn) {
    clearDataBtn.addEventListener('click', () => window.clearAll());
  }
  if (assetToggleBtn) {
    assetToggleBtn.addEventListener('click', () => window.toggleAssetPanel());
  }
  if (searchBoxEl) {
    searchBoxEl.addEventListener('input', event => filterAssets(event.target.value));
  }
  if (boCopyBtnEl) {
    boCopyBtnEl.addEventListener('click', () => window.copyBO(boCopyBtnEl));
  }
  if (boImportBtnEl) {
    boImportBtnEl.addEventListener('click', () => openBoImportModal());
  }
  if (boRenameBtnEl) {
    boRenameBtnEl.addEventListener('click', () => window.renameActiveTrackSet());
  }
  if (boRemovePlayerBtnEl) {
    boRemovePlayerBtnEl.addEventListener('click', () => window.deleteActiveTrackSet());
  }
  if (boToggleBtn) {
    boToggleBtn.addEventListener('click', () => window.toggleBoPanel());
  }
  if (timelineZoomOutBtn) {
    timelineZoomOutBtn.addEventListener('click', () => window.zoom(-1));
  }
  if (timelineZoomInBtn) {
    timelineZoomInBtn.addEventListener('click', () => window.zoom(1));
  }
  if (unitToggleBtn) {
    unitToggleBtn.addEventListener('click', () => window.toggleUnitsVisibility());
  }
  if (combatWorkersBtn) {
    combatWorkersBtn.addEventListener('click', () => window.toggleCombatCategory('workers'));
  }
  if (combatUnitsBtn) {
    combatUnitsBtn.addEventListener('click', () => window.toggleCombatCategory('units'));
  }
  if (combatBuildingsBtn) {
    combatBuildingsBtn.addEventListener('click', () => window.toggleCombatCategory('buildings'));
  }
  if (combatToggleBtn) {
    combatToggleBtn.addEventListener('click', () => window.toggleCombatPanel());
  }
  if (boImportBackdropEl) {
    boImportBackdropEl.addEventListener('click', () => closeBoImportModal());
  }
  if (boImportCloseBtnEl) {
    boImportCloseBtnEl.addEventListener('click', () => closeBoImportModal());
  }
  if (boImportCancelBtnEl) {
    boImportCancelBtnEl.addEventListener('click', () => closeBoImportModal());
  }
  if (boImportApplyBtnEl) {
    boImportApplyBtnEl.addEventListener('click', () => window.parseAndApply());
  }
}
function analysisSourceLabel(allSets, fallbackToUnknown = true) {
  const embeddedCount = (allSets || []).filter(set => set.sourceKind === 'embedded').length;
  const importedCount = (allSets || []).filter(set => set.sourceKind === 'imported').length;
  if (embeddedCount && importedCount) return 'Embedded analysis + imported player data';
  if (embeddedCount) return 'Embedded analysis';
  if (importedCount) return 'Imported player data';
  return fallbackToUnknown ? 'Unknown' : 'Analysis loaded';
}
function formatGameTime(seconds) {
  return fmt(Math.round(Number.isFinite(seconds) ? seconds : 0));
}
function knownDeathCost(unitType) {
  const normalized = normalizeUnitTypeKey(unitType);
  if (!deathCostByUnitType.has(normalized)) return null;
  return deathCostByUnitType.get(normalized);
}
function combatCategoryOrder(category) {
  if (category === 'worker') return 0;
  if (category === 'unit') return 1;
  if (category === 'building') return 2;
  return 3;
}
function combatPerspectiveOrder(perspective) {
  return perspective === 'enemy' ? 0 : 1;
}
function compareCombatEvents(a, b) {
  return a.time_seconds - b.time_seconds
    || combatPerspectiveOrder(a.perspective) - combatPerspectiveOrder(b.perspective)
    || combatCategoryOrder(a.category) - combatCategoryOrder(b.category)
    || a.displayName.localeCompare(b.displayName)
    || (a.originalOrder || 0) - (b.originalOrder || 0);
}
function ordinalLabel(value) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
}
function formatResourceValue(value) {
  return `${Math.round(Number.isFinite(value) ? value : 0)}`;
}
function formatSignedResourceValue(value) {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}
function formatResourceDelta(enemyTotals, ownTotals, mode = 'full') {
  const enemyMinerals = Number.isFinite(enemyTotals && enemyTotals.minerals) ? enemyTotals.minerals : 0;
  const enemyGas = Number.isFinite(enemyTotals && enemyTotals.gas) ? enemyTotals.gas : 0;
  const ownMinerals = Number.isFinite(ownTotals && ownTotals.minerals) ? ownTotals.minerals : 0;
  const ownGas = Number.isFinite(ownTotals && ownTotals.gas) ? ownTotals.gas : 0;
  const netMinerals = enemyMinerals - ownMinerals;
  const netGas = enemyGas - ownGas;
  if (mode === 'net') return `net ${formatSignedResourceValue(netMinerals)}m/${formatSignedResourceValue(netGas)}g`;
  return `enemy lost ${formatResourceValue(enemyMinerals)}m/${formatResourceValue(enemyGas)}g; self lost ${formatResourceValue(ownMinerals)}m/${formatResourceValue(ownGas)}g; net ${formatSignedResourceValue(netMinerals)}m/${formatSignedResourceValue(netGas)}g`;
}
function formatUnitCounts(counts) {
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts || {});
  const filtered = entries
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([unitType, count]) => {
      const displayName = getDeathDisplayName(unitType);
      return { unitType, count, displayName };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (!filtered.length) return 'none';
  return filtered
    .map(entry => `${entry.count} ${pluralizeUnitLabel(entry.displayName, entry.count)}`)
    .join(', ');
}
function ledgerRaceLabel(set) {
  const race = set && set.playerData && typeof set.playerData.race === 'string'
    ? set.playerData.race
    : set && set.deathsData && typeof set.deathsData.race === 'string'
      ? set.deathsData.race
      : '';
  return race ? titleizeUnitType(race) : 'Unknown';
}
function combatPerspectiveInfo(playerSet, allSets) {
  const players = Array.isArray(allSets) ? allSets.filter(Boolean) : [];
  const isDuel = players.length === 2;
  const opponentSet = isDuel ? players.find(set => set.id !== playerSet.id) || null : null;
  return {
    isDuel,
    opponentName: players.length <= 1 ? 'unknown' : (isDuel ? (opponentSet ? opponentSet.name : 'unknown') : 'multiple'),
    enemySummaryLabel: isDuel ? 'killed' : 'enemy losses',
    ownSummaryLabel: isDuel ? 'lost' : 'own losses',
  };
}
function milestonePerspectiveLabel(perspective, isDuel) {
  if (isDuel) return perspective === 'enemy' ? 'killed' : 'lost';
  return perspective === 'enemy' ? 'enemy' : 'own';
}
function combatEventsForPerspective(playerSet, allSets) {
  const unknownCostTypes = new Set();
  const events = (allSets || []).flatMap(set => {
    const samples = combatDeathsForSet(set);
    return samples
      .filter(sample => deathCategoryLane(sample.category))
      .map(sample => {
        const normalizedType = normalizeUnitTypeKey(sample.unit_type);
        const displayName = getDeathDisplayName(sample.unit_type);
        const cost = knownDeathCost(sample.unit_type);
        if (!cost) unknownCostTypes.add(displayName);
        return {
          setId: set.id,
          playerName: set.name,
          perspective: set.id === playerSet.id ? 'own' : 'enemy',
          time_seconds: Number(sample.time_seconds),
          category: sample.category,
          lane: deathCategoryLane(sample.category),
          unitType: normalizedType,
          displayName,
          mineralCost: cost ? cost.mineralCost : 0,
          gasCost: cost ? cost.gasCost : 0,
          hasKnownCost: !!cost,
          originalOrder: Number.isFinite(sample.original_order) ? sample.original_order : 0,
        };
      });
  }).sort(compareCombatEvents);
  return { events, unknownCostTypes };
}
function setHasCombatData(set) {
  return combatDeathsForSet(set)
    .some(sample => deathCategoryLane(sample.category));
}
function summarizePerspectiveEvents(events) {
  const summary = {
    enemyCount: 0,
    ownCount: 0,
    enemyCounts: new Map(),
    ownCounts: new Map(),
    enemyTotals: { minerals: 0, gas: 0 },
    ownTotals: { minerals: 0, gas: 0 },
  };
  events.forEach(event => {
    const isEnemy = event.perspective === 'enemy';
    const counts = isEnemy ? summary.enemyCounts : summary.ownCounts;
    counts.set(event.unitType, (counts.get(event.unitType) || 0) + 1);
    if (isEnemy) summary.enemyCount += 1;
    else summary.ownCount += 1;
    if (!event.hasKnownCost) return;
    const totals = isEnemy ? summary.enemyTotals : summary.ownTotals;
    totals.minerals += event.mineralCost;
    totals.gas += event.gasCost;
  });
  return summary;
}
function buildCombatCheckpointLines(playerSet, allSets) {
  const perspective = combatPerspectiveInfo(playerSet, allSets);
  const { events } = combatEventsForPerspective(playerSet, allSets);
  if (!events.some(event => event.time_seconds <= COMBAT_LEDGER_CHECKPOINTS[COMBAT_LEDGER_CHECKPOINTS.length - 1])) {
    return ['No combat deaths through 12:00.'];
  }
  const lines = [];
  let previousKey = '';
  COMBAT_LEDGER_CHECKPOINTS.forEach(time => {
    const summary = summarizePerspectiveEvents(events.filter(event => event.time_seconds <= time));
    if (!summary.enemyCount && !summary.ownCount) return;
    const nextKey = JSON.stringify({
      enemyCount: summary.enemyCount,
      ownCount: summary.ownCount,
      enemyCounts: [...summary.enemyCounts.entries()],
      ownCounts: [...summary.ownCounts.entries()],
    });
    if (nextKey === previousKey) return;
    previousKey = nextKey;
    lines.push(
      `${formatGameTime(time)}  ${perspective.enemySummaryLabel} ${formatUnitCounts(summary.enemyCounts)}; `
      + `${perspective.ownSummaryLabel} ${formatUnitCounts(summary.ownCounts)}; `
      + `${formatResourceDelta(summary.enemyTotals, summary.ownTotals, 'full')}`,
    );
  });
  return lines;
}
function buildCombatMilestoneLines(playerSet, allSets) {
  const perspective = combatPerspectiveInfo(playerSet, allSets);
  const { events } = combatEventsForPerspective(playerSet, allSets);
  if (!events.length) return ['No combat milestones recorded.'];
  const lines = [];
  const seenUniversal = new Set();
  const seenUnitCounts = new Map();
  const universalLabels = { worker: 'worker', unit: 'army', building: 'building' };
  events.forEach(event => {
    const universalKey = `${event.perspective}:${event.category}`;
    if (!seenUniversal.has(universalKey) && universalLabels[event.category]) {
      seenUniversal.add(universalKey);
      lines.push({
        ...event,
        text: perspective.isDuel
          ? `${formatGameTime(event.time_seconds)}  First ${event.perspective === 'enemy' ? 'killed' : 'lost'} ${universalLabels[event.category]}: ${event.displayName}`
          : `${formatGameTime(event.time_seconds)}  First ${event.perspective} ${universalLabels[event.category]} loss: ${event.displayName}`,
      });
    }
    const countKey = `${event.perspective}:${event.unitType}`;
    const nextCount = (seenUnitCounts.get(countKey) || 0) + 1;
    seenUnitCounts.set(countKey, nextCount);
    const shouldEmit = nextCount === 1
      || (COMBAT_STRATEGIC_MILESTONE_TYPES.has(event.unitType) && (nextCount === 2 || nextCount === 5 || nextCount === 10));
    if (!shouldEmit) return;
    lines.push({
      ...event,
      text: perspective.isDuel
        ? `${formatGameTime(event.time_seconds)}  ${nextCount === 1 ? 'First' : ordinalLabel(nextCount)} ${milestonePerspectiveLabel(event.perspective, true)} ${event.displayName}`
        : `${formatGameTime(event.time_seconds)}  ${nextCount === 1 ? 'First' : ordinalLabel(nextCount)} ${milestonePerspectiveLabel(event.perspective, false)} ${event.displayName} loss`,
    });
  });
  return lines
    .sort(compareCombatEvents)
    .map(line => line.text);
}
function buildCombatWindowLines(playerSet, allSets) {
  const perspective = combatPerspectiveInfo(playerSet, allSets);
  const { events } = combatEventsForPerspective(playerSet, allSets);
  if (!events.length) return ['No combat windows recorded.'];
  const windows = [];
  let currentWindow = null;
  events.forEach(event => {
    if (!currentWindow || (event.time_seconds - currentWindow.end) > COMBAT_WINDOW_GAP_SECS) {
      currentWindow = { start: event.time_seconds, end: event.time_seconds, events: [event] };
      windows.push(currentWindow);
      return;
    }
    currentWindow.end = event.time_seconds;
    currentWindow.events.push(event);
  });
  return windows.map(window => {
    const summary = summarizePerspectiveEvents(window.events);
    return `${formatGameTime(window.start)}-${formatGameTime(window.end)}  `
      + `${perspective.enemySummaryLabel} ${formatUnitCounts(summary.enemyCounts)}; `
      + `${perspective.ownSummaryLabel} ${formatUnitCounts(summary.ownCounts)}; `
      + `${formatResourceDelta(summary.enemyTotals, summary.ownTotals, 'net')}`;
  });
}
function buildCombatLedgerText(playerSet, allSets, options = {}) {
  if (!playerSet) return '';
  const perspective = combatPerspectiveInfo(playerSet, allSets);
  const playerHasCombatData = setHasCombatData(playerSet);
  const { unknownCostTypes } = playerHasCombatData
    ? combatEventsForPerspective(playerSet, allSets)
    : { unknownCostTypes: new Set() };
  const lines = [
    `Combat Ledger — ${playerSet.name} perspective`,
    `Race: ${ledgerRaceLabel(playerSet)}`,
    `Opponent: ${perspective.opponentName}`,
    '',
    'Cumulative checkpoints',
    ...(playerHasCombatData ? buildCombatCheckpointLines(playerSet, allSets) : ['No combat deaths through 12:00.']),
    '',
    'Milestones',
    ...(playerHasCombatData ? buildCombatMilestoneLines(playerSet, allSets) : ['No combat milestones recorded.']),
    '',
    'Combat windows',
    ...(playerHasCombatData ? buildCombatWindowLines(playerSet, allSets) : ['No combat windows recorded.']),
  ];
  if (unknownCostTypes.size) {
    lines.push('', `Note: resource totals exclude unknown-cost types: ${[...unknownCostTypes].sort((a, b) => a.localeCompare(b)).join(', ')}.`);
  }
  if (options.trailingNewline) lines.push('');
  return lines.join('\n');
}
function hasAnyCombatData() {
  return sets.some(set => combatDeathsForSet(set).some(sample => deathCategoryLane(sample.category)));
}
function raceLabel(set) {
  return ledgerRaceLabel(set);
}
function loadedPlayerListText(allSets) {
  if (!(allSets || []).length) return 'unknown';
  return allSets.map(set => `${set.name} (${raceLabel(set)})`).join(', ');
}
function matchupRaceCode(race) {
  const normalized = normalizeUnitTypeKey(race);
  if (normalized === 'terran') return 'T';
  if (normalized === 'protoss') return 'P';
  if (normalized === 'zerg') return 'Z';
  return null;
}
function analysisMatchupText(allSets) {
  const codes = (allSets || []).map(set => matchupRaceCode(raceLabel(set)));
  if (!codes.length || codes.some(code => !code)) return 'unknown';
  return codes.join('v');
}
function analysisMapText() {
  return 'unknown';
}
const COMPOSITION_EXCLUDED_TYPES = new Set(['larva', 'egg']);
const COMPOSITION_WORKER_TYPES = new Set(['scv', 'probe', 'drone']);
const COMPOSITION_BASIC_ARMY_TYPES = new Set([
  'marine', 'firebat', 'vulture', 'zealot', 'dragoon', 'zergling', 'hydralisk',
]);
const COMPOSITION_SPECIAL_UNIT_TYPES = new Set([
  'ghost', 'medic', 'science_vessel', 'dropship', 'observer', 'shuttle',
  'high_templar', 'dark_templar', 'archon', 'dark_archon', 'reaver', 'arbiter',
  'queen', 'defiler', 'lurker',
]);
const COMPOSITION_SUPPLY_TYPES = new Set(['overlord', 'pylon', 'supply_depot']);
const COMPOSITION_STATIC_DEFENSE_TYPES = new Set([
  'bunker', 'missile_turret', 'photon_cannon', 'shield_battery',
  'sunken_colony', 'spore_colony', 'creep_colony',
]);
const COMPOSITION_PRODUCTION_BUILDING_TYPES = new Set([
  'barracks', 'factory', 'starport', 'gateway', 'robotics_facility', 'stargate',
  'spawning_pool', 'hydralisk_den', 'spire', 'greater_spire',
]);
const COMPOSITION_TECH_BUILDING_TYPES = new Set([
  'refinery', 'engineering_bay', 'academy', 'science_facility', 'armory',
  'machine_shop', 'control_tower', 'physics_lab', 'covert_ops',
  'assimilator', 'forge', 'cybernetics_core', 'citadel_of_adun', 'robotics_support_bay',
  'fleet_beacon', 'templar_archives', 'observatory', 'arbiter_tribunal',
  'extractor', 'evolution_chamber', 'queens_nest', 'ultralisk_cavern',
  'defiler_mound', 'nydus_canal',
]);
const COMPOSITION_TOWN_HALL_TYPES = new Set([
  'command_center', 'nexus', 'hatchery', 'lair', 'hive',
]);
const compositionDataByUnitType = new Map(
  (typeof DATA !== 'undefined' ? DATA : []).map(item => ([normalizeUnitTypeKey(item.name), item])),
);
const compositionDataIndexByUnitType = new Map(
  (typeof DATA !== 'undefined' ? DATA : []).map((item, index) => ([normalizeUnitTypeKey(item.name), index])),
);
function getUnitCountsSampleAtOrBefore(samples, timeSeconds) {
  if (!Array.isArray(samples) || !samples.length) return null;
  let result = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.time_seconds) || sample.time_seconds > timeSeconds) break;
    result = sample;
  }
  return result;
}
function shouldIncludeCompositionCount(unitType, count) {
  if (!Number.isFinite(count) || count <= 0) return false;
  return !COMPOSITION_EXCLUDED_TYPES.has(normalizeUnitTypeKey(unitType));
}
function compositionCategoryRank(unitType) {
  const normalized = normalizeUnitTypeKey(unitType);
  const dataItem = compositionDataByUnitType.get(normalized);
  if (COMPOSITION_WORKER_TYPES.has(normalized)) return 1;
  if (COMPOSITION_BASIC_ARMY_TYPES.has(normalized)) return 2;
  if ((dataItem && dataItem.type === 'Unit' && !COMPOSITION_SPECIAL_UNIT_TYPES.has(normalized) && !COMPOSITION_SUPPLY_TYPES.has(normalized)) || false) return 3;
  if (COMPOSITION_SPECIAL_UNIT_TYPES.has(normalized)) return 4;
  if (COMPOSITION_SUPPLY_TYPES.has(normalized)) return 5;
  if (COMPOSITION_STATIC_DEFENSE_TYPES.has(normalized)) return 6;
  if (COMPOSITION_PRODUCTION_BUILDING_TYPES.has(normalized)) return 7;
  if (COMPOSITION_TOWN_HALL_TYPES.has(normalized)) return 9;
  if (COMPOSITION_TECH_BUILDING_TYPES.has(normalized) || (dataItem && (dataItem.type === 'Building' || dataItem.type === 'Addon'))) return 8;
  return 10;
}
function pluralizeCompositionLabel(label, count) {
  if (count === 1) return label;
  if (/[aeiou]y$/i.test(label)) return `${label}s`;
  if (/y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  if (/s$/i.test(label)) return label;
  return `${label}s`;
}
function formatCompositionCounts(counts) {
  const entries = Object.entries(counts || {})
    .filter(([unitType, count]) => shouldIncludeCompositionCount(unitType, count))
    .map(([unitType, count]) => {
      const displayName = getDeathDisplayName(unitType);
      return {
        unitType: normalizeUnitTypeKey(unitType),
        displayName,
        count: Math.round(count),
        categoryRank: compositionCategoryRank(unitType),
        dataIndex: compositionDataIndexByUnitType.has(normalizeUnitTypeKey(unitType))
          ? compositionDataIndexByUnitType.get(normalizeUnitTypeKey(unitType))
          : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((a, b) => a.categoryRank - b.categoryRank || a.dataIndex - b.dataIndex || a.displayName.localeCompare(b.displayName));
  if (!entries.length) return 'none';
  return entries.map(entry => `${entry.count} ${pluralizeCompositionLabel(entry.displayName, entry.count)}`).join(', ');
}
function buildCompositionSnapshotsText(playerSet) {
  const samples = playerSet && playerSet.armyData && Array.isArray(playerSet.armyData.samples) ? playerSet.armyData.samples : [];
  if (!samples.length) return '  None.';
  const lastSampleTime = samples[samples.length - 1].time_seconds;
  const lines = COMBAT_LEDGER_CHECKPOINTS
    .filter(time => time <= lastSampleTime)
    .map(time => {
      const sample = getUnitCountsSampleAtOrBefore(samples, time);
      const countsText = sample ? formatCompositionCounts(sample.counts || {}) : 'none';
      return `${formatGameTime(time)}  ${countsText}`;
    });
  return lines.length ? lines.join('\n') : '  None.';
}
function buildPlayerAnalysisSection(set, allSets) {
  const buildOrderText = buildOrderCopyTextForSet(set);
  const compositionSnapshotsText = buildCompositionSnapshotsText(set);
  return [
    ANALYSIS_REPORT_SEPARATOR,
    `Player: ${set.name}`,
    `Race: ${raceLabel(set)}`,
    '',
    'Build Order:',
    buildOrderText ? buildOrderText : '  None.',
    '',
    'Composition Snapshots:',
    compositionSnapshotsText,
    '',
    'Combat Ledger:',
    buildCombatLedgerText(set, allSets),
  ].join('\n');
}
function buildFullAnalysisReport(allSets) {
  const loadedSets = Array.isArray(allSets) ? allSets : [];
  const sections = loadedSets.map(set => buildPlayerAnalysisSection(set, loadedSets));
  return [
    'Brood War Build Analysis Report',
    '',
    'Analysis:',
    `  Players: ${loadedSets.length}`,
    `  Player list: ${loadedPlayerListText(loadedSets)}`,
    `  Source: ${analysisSourceLabel(loadedSets)}`,
    `  Original replay available: ${embeddedReplayUrl ? 'yes' : 'no'}`,
    `  Map: ${analysisMapText()}`,
    `  Matchup: ${analysisMatchupText(loadedSets)}`,
    '',
    ...sections,
  ].join('\n');
}
function buildAnalysisPrompt() {
  return [
    'You are analyzing a StarCraft: Brood War replay report.',
    '',
    'The report contains two main axes of evidence for each player:',
    '',
    '1. Build Order — what the player made or researched, and when.',
    '2. Combat Ledger — what the player killed/lost over time, including cumulative checkpoints, milestones, and combat windows.',
    '',
    'Please analyze the replay with emphasis on:',
    '- each player’s opening and strategic direction',
    '- major build-order divergences or tech transitions',
    '- key timing windows',
    '- whether combat outcomes supported or contradicted each player’s build plan',
    '- important economic or resource-trade implications',
    '- any major turning points visible from the data',
    '',
    'Be specific. Cite timings from the report when possible. Avoid overclaiming beyond the evidence.',
  ].join('\n');
}
function buildPromptAndAnalysisReport(allSets) {
  const report = buildFullAnalysisReport(allSets);
  const prompt = buildAnalysisPrompt();
  return [
    prompt,
    '',
    ANALYSIS_REPORT_SEPARATOR,
    'REPORT',
    ANALYSIS_REPORT_SEPARATOR,
    '',
    report,
  ].join('\n');
}
function syncAnalysisCopyUi() {
  const disabled = !sets.length;
  if (analysisCopyBtnEl) {
    analysisCopyBtnEl.disabled = disabled;
    analysisCopyBtnEl.setAttribute('aria-expanded', 'false');
  }
  if (analysisCopyFullBtnEl) analysisCopyFullBtnEl.disabled = disabled;
  if (analysisCopyPromptBtnEl) analysisCopyPromptBtnEl.disabled = disabled;
  if (disabled) closeAnalysisCopyMenu();
}
function copyFullAnalysisReport() {
  const button = analysisCopyBtnEl;
  if (!sets.length) {
    setTemporaryButtonText(button, 'No analysis data available');
    closeAnalysisCopyMenu();
    return Promise.resolve(false);
  }

  const text = buildFullAnalysisReport(sets);

  return copyTextToClipboard(text).then(() => {
    setTemporaryButtonText(button, `Copied full analysis report for ${sets.length} players.`);
    return true;
  }).catch(err => {
    console.error(err);
    setTemporaryButtonText(button, 'Copy failed.');
    throw err;
  }).finally(() => {
    closeAnalysisCopyMenu();
  });
}
function copyPromptAndAnalysisReport() {
  const button = analysisCopyBtnEl;
  if (!sets.length) {
    setTemporaryButtonText(button, 'No analysis data available');
    closeAnalysisCopyMenu();
    return;
  }
  const text = buildPromptAndAnalysisReport(sets);
  copyTextToClipboard(text).then(() => {
    setTemporaryButtonText(button, `Copied prompt + analysis report for ${sets.length} players.`);
  }).catch(err => {
    console.error(err);
    setTemporaryButtonText(button, 'Copy failed.');
  });
  closeAnalysisCopyMenu();
}
function syncCombatCopyUi() {
  const disabled = !hasAnyCombatData();
  if (combatCopyBtnEl) {
    combatCopyBtnEl.disabled = disabled;
    combatCopyBtnEl.setAttribute('aria-expanded', 'false');
  }
  if (combatCopyFocusedBtnEl) combatCopyFocusedBtnEl.disabled = disabled;
  if (combatCopyAllBtnEl) combatCopyAllBtnEl.disabled = disabled;
  if (disabled) closeCombatCopyMenu();
}
function setTemporaryButtonText(button, text, duration = 1400) {
  if (!button) return;
  const defaultLabel = button.dataset.defaultLabel || button.textContent;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = defaultLabel;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || defaultLabel;
  }, duration);
}
function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', 'true');
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      const ok = document.execCommand('copy');
      textArea.remove();
      if (!ok) throw new Error('Clipboard unavailable.');
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}
function copyCombatLedger(mode = 'focused') {
  const button = combatCopyBtnEl;
  if (!hasAnyCombatData()) {
    setTemporaryButtonText(button, 'No combat data.');
    closeCombatCopyMenu();
    return;
  }
  const focusedSet = activeSet();
  const text = mode === 'all'
    ? sets.map(set => buildCombatLedgerText(set, sets)).join(`\n${COMBAT_LEDGER_SEPARATOR}\n`)
    : buildCombatLedgerText(focusedSet, sets);
  if (!text) {
    setTemporaryButtonText(button, 'No combat data.');
    closeCombatCopyMenu();
    return;
  }
  copyTextToClipboard(text).then(() => {
    if (mode === 'all') setTemporaryButtonText(button, `Copied combat summaries for ${sets.length} players.`);
    else setTemporaryButtonText(button, `Copied combat summary for ${focusedSet ? focusedSet.name : 'player'}.`);
  }).catch(err => {
    console.error(err);
    setTemporaryButtonText(button, 'Copy failed.');
  });
  closeCombatCopyMenu();
}
function parseBuildOrderLineTime(line) {
  const match = line.trim().match(/^(?:\((\d+)\)\s+)?(-?\d+:\d{2})\s+(.+)$/);
  if (!match || typeof window.parseTime !== 'function') return null;
  return window.parseTime(match[2]);
}
function parseBuildOrderLine(line) {
  const match = line.trim().match(/^(?:\((\d+)\)\s+)?(-?\d+:\d{2})\s+(.+)$/);
  if (!match || typeof window.parseTime !== 'function') return null;
  const startTime = window.parseTime(match[2]);
  if (startTime === null) return null;
  return {
    trackIndex: match[1] != null ? parseInt(match[1], 10) - 1 : null,
    startTime,
    name: match[3].trim(),
  };
}
function itemFromBuildOrderLine(line) {
  const parsed = parseBuildOrderLine(line);
  if (!parsed) return null;
  const set = activeSet();
  if (!set) return null;
  const tracks = parsed.trackIndex != null ? [parsed.trackIndex] : set.tracks.map((_, index) => index);
  for (const trackIndex of tracks) {
    const track = set.tracks[trackIndex];
    if (!track) continue;
    const item = track.find(entry => entry.startTime === parsed.startTime && entry.name === parsed.name);
    if (item) return item;
  }
  return set.tracks.flat().find(entry => entry.startTime === parsed.startTime && entry.name === parsed.name) || null;
}
function centerTimelineOnItem(item) {
  const blockEl = document.querySelector(`.bl[data-id="${item.id}"]`);
  if (!blockEl) return;
  const scrollRect = tlScroll.getBoundingClientRect();
  const blockRect = blockEl.getBoundingClientRect();
  const targetLeft = tlScroll.scrollLeft + (blockRect.left - scrollRect.left) - (scrollRect.width / 2) + (blockRect.width / 2);
  //const targetTop = tlScroll.scrollTop + (blockRect.top - scrollRect.top) - (scrollRect.height / 2) + (blockRect.height / 2);
  tlScroll.scrollLeft = Math.max(0, targetLeft);
  //tlScroll.scrollTop = Math.max(0, targetTop);
}
function focusBuildOrderItem(itemId) {
  const found = findItem(itemId);
  if (!found) return;
  activeSetId = found.set.id;
  selectedIds = new Set([itemId]);
  window.render(true);
  centerTimelineOnItem(found.item);
}

function syncAssetPanelUi() {
  appEl.classList.toggle('asset-panel-collapsed', assetPanelCollapsed);
  assetToggleBtn.textContent = assetPanelCollapsed ? '>' : '<';
  assetToggleBtn.title = assetPanelCollapsed ? 'Show assets' : 'Hide assets';
}
function syncBoPanelUi() {
  appEl.classList.toggle('bo-panel-collapsed', boPanelCollapsed);
  closeBoMoreMenu();
  if (boPanelCollapsed) {
    boExpandedWidth = boSectionEl.style.width || `${boSectionEl.getBoundingClientRect().width}px`;
    boSectionEl.style.width = '44px';
  } else if (boExpandedWidth) {
    boSectionEl.style.width = boExpandedWidth;
  } else {
    boSectionEl.style.removeProperty('width');
  }
  if (boPanelCollapsed) {
    boHeaderActionsEl.prepend(boToggleBtn);
    boHeaderEl.prepend(boHeaderActionsEl);
  } else {
    boHeaderActionsEl.appendChild(boToggleBtn);
    boHeaderEl.appendChild(boHeaderActionsEl);
  }
  boToggleBtn.textContent = boPanelCollapsed ? '>' : '<';
  boToggleBtn.title = boPanelCollapsed ? 'Show build order' : 'Hide build order';
}
function visibleBuildOrderItems(set) {
  if (!set) return [];
  return set.tracks
    .flat()
    .filter(item => showUnits || item.type !== 'Unit')
    .sort((a, b) => a.startTime - b.startTime || a.trackIndex - b.trackIndex || a.id - b.id);
}
function buildOrderTextForSet(set) {
  if (!set) return '';
  const all = set.tracks.flat().sort((a, b) => a.startTime - b.startTime || a.trackIndex - b.trackIndex || a.id - b.id);
  const multiTrack = set.tracks.filter(track => track.length).length > 1;
  return all.map(item => `${multiTrack ? `(${item.trackIndex + 1}) ` : ''}${fmt(item.startTime)}  ${item.name}`).join('\n');
}
function buildOrderCopyTextForSet(set) {
  if (!set) return '';
  const workerNames = new Set(['SCV', 'Probe', 'Drone']);
  const all = set.tracks
    .flat()
    .filter(item => !workerNames.has(item.name))
    .sort((a, b) => a.startTime - b.startTime || a.trackIndex - b.trackIndex || a.id - b.id);
  const supplySamples = set.supplyData && Array.isArray(set.supplyData.samples) ? set.supplyData.samples : [];
  return all.map(item => {
    const supply = supplySamples.length ? sampleSupplyAt(supplySamples, item.startTime) : null;
    const supplyText = supply && Number.isFinite(supply.current) && Number.isFinite(supply.max)
      ? `${supply.current}/${supply.max}`
      : '--/--';
    return `${fmt(item.startTime)}  ${supplyText}  ${item.name}`;
  }).join('\n');
}
function renderBuildOrderTable() {
  const set = activeSet();
  const rows = visibleBuildOrderItems(set);
  syncFocusedPlayerUi();
  if (!set) {
    boTableEl.hidden = true;
    boEmptyEl.style.display = 'flex';
    boEmptyEl.textContent = 'No analysis data loaded. Import generated player data to begin.';
    return;
  }
  if (!rows.length) {
    boTableEl.hidden = true;
    boEmptyEl.style.display = 'flex';
    boEmptyEl.textContent = showUnits ? 'No build-order items in the active set.' : 'No visible build-order items. Use Show Units to reveal unit rows.';
    return;
  }
  const supplySamples = set.supplyData && Array.isArray(set.supplyData.samples) ? set.supplyData.samples : [];
  boTableBodyEl.innerHTML = '';
  rows.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = `bo-row bo-row-${String(item.type || '').toLowerCase()}`;
    if (selectedIds.has(item.id)) tr.classList.add('is-selected');
    tr.dataset.id = String(item.id);

    const supply = supplySamples.length ? sampleSupplyAt(supplySamples, item.startTime) : null;
    const supplyText = supply && Number.isFinite(supply.current) && Number.isFinite(supply.max)
      ? `${supply.current}/${supply.max}`
      : '—';

    tr.innerHTML = `<td class="bo-cell-time">${fmt(item.startTime)}</td>`
      + `<td class="bo-cell-supply">${escapeHtml(supplyText)}</td>`
      + `<td class="bo-cell-name">${escapeHtml(item.name)}</td>`;
    tr.addEventListener('click', () => focusBuildOrderItem(item.id));
    boTableBodyEl.appendChild(tr);
  });
  boEmptyEl.style.display = 'none';
  boTableEl.hidden = false;
}
function openBoImportModal() {
  boImportModalEl.classList.add('is-open');
  boImportModalEl.setAttribute('aria-hidden', 'false');
  boText.value = buildOrderTextForSet(activeSet());
  setTimeout(() => {
    boText.focus();
    boText.select();
  }, 0);
}
function closeBoImportModal() {
  boImportModalEl.classList.remove('is-open');
  boImportModalEl.setAttribute('aria-hidden', 'true');
}

function createSet(name, sourceKind = null) {
  return { id: nextSetId++, name, tracks: [[]], economyData: null, supplyData: null, armyData: null, deathsData: null, playerData: null, sourceKind };
}
function resetState() { nextItemId = 0; nextSetId = 1; selectedIds = new Set(); sets = []; activeSetId = null; }
function activeSet() { if (!sets.length) return null; if (!sets.some(s => s.id === activeSetId)) activeSetId = sets[0].id; return sets.find(s => s.id === activeSetId) || null; }
function ensureTrack(set, ti) { while (set.tracks.length <= ti) set.tracks.push([]); }
function makeItem(src, setId, trackIndex, startTime, idOverride) {
  const id = typeof idOverride === 'number' ? idOverride : nextItemId++;
  if (typeof idOverride === 'number') nextItemId = Math.max(nextItemId, idOverride + 1);
  return {
    id,
    name: src.name,
    race: src.race,
    type: src.type,
    buildTime: src.buildTime,
    mineralCost: src.mineralCost,
    gasCost: src.gasCost,
    supplyCost: src.supplyCost,
    builtFrom: src.builtFrom,
    startTime,
    trackIndex,
    trackSetId: setId,
  };
}
function allItems() { return sets.flatMap(set => set.tracks.flat()); }
function normalizeSet(set) {
  const allItems = (set.tracks || []).flat();
  if (!allItems.length) {
    set.tracks = [[]];
    return;
  }

  // Separate items into two groups: Non-Units (Buildings, Upgrades, Addons) and Units
  const nonUnits = allItems.filter(it => it.type !== 'Unit');
  const units    = allItems.filter(it => it.type === 'Unit');

  // Sort each group by startTime, then original trackIndex, then id for a stable, predictable repack
  const sortFn = (a, b) => a.startTime - b.startTime || (a.trackIndex || 0) - (b.trackIndex || 0) || a.id - b.id;
  nonUnits.sort(sortFn);
  units.sort(sortFn);

  const newTracks = [];

  // Helper to pack a group of items into the next available tracks
  const pack = (group) => {
    const groupTracks = [];
    group.forEach(item => {
      let placed = false;
      for (let ti = 0; ti < groupTracks.length; ti++) {
        if (!overlaps2(groupTracks[ti], item.startTime, item.buildTime, [item.id])) {
          groupTracks[ti].push(item);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groupTracks.push([item]);
      }
    });
    newTracks.push(...groupTracks);
  };

  // Pack non-units first (top of timeline), then units (bottom of timeline)
  pack(nonUnits);
  pack(units);

  set.tracks = newTracks.length ? newTracks : [[]];

  // Update indices and ensure trackSetId is correct
  set.tracks.forEach((track, ti) => {
    track.forEach(item => {
      item.trackIndex = ti;
      item.trackSetId = set.id;
    });
  });
}
function normalizeState() {
  sets.forEach(normalizeSet);
  if (!sets.length) { activeSetId = null; }
  else if (!sets.some(set => set.id === activeSetId)) activeSetId = sets[0].id;
  const validIds = new Set(allItems().map(item => item.id));
  selectedIds = new Set([...selectedIds].filter(id => validIds.has(id)));
}
function overlaps2(trackItems, startTime, duration, excludeIds = []) {
  const excluded = new Set(Array.isArray(excludeIds) ? excludeIds : [excludeIds]);
  const end = startTime + duration;
  return trackItems.some(item => !excluded.has(item.id) && startTime < item.startTime + item.buildTime && end > item.startTime);
}
function findItem(id) {
  for (const set of sets) {
    for (let ti = 0; ti < set.tracks.length; ti++) {
      const item = set.tracks[ti].find(entry => entry.id === id);
      if (item) return { set, item, trackIndex: ti };
    }
  }
  return null;
}
function timeRange2() {
  const items = allItems();
  let latest = items.length ? Math.max(...items.map(item => item.startTime + item.buildTime)) : 0;
  
  sets.forEach(set => {
    const economySamples = set.economyData && Array.isArray(set.economyData.samples) ? set.economyData.samples : [];
    const supplySamples = set.supplyData && Array.isArray(set.supplyData.samples) ? set.supplyData.samples : [];
    const deathsSamples = set.deathsData && Array.isArray(set.deathsData.samples) ? set.deathsData.samples : [];
    if (economySamples.length) {
      latest = Math.max(latest, ...economySamples.map(sample => sample.time_seconds));
    }
    if (supplySamples.length) {
      latest = Math.max(latest, ...supplySamples.map(sample => sample.time_seconds));
    }
    if (deathsSamples.length) {
      latest = Math.max(latest, ...deathsSamples.map(sample => sample.time_seconds));
    }
  });

  const earliest = items.length ? Math.min(...items.map(item => item.startTime)) : 0;
  return { min: earliest < 0 ? earliest - 10 : 0, max: Math.max(MIN_DUR, latest + WIGGLE) };
}
function encodeState() { return ''; }
function persistState() { try { localStorage.removeItem(FORGE_LS_KEY); } catch {} if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
function decodeState2(encoded) {
  const raw = JSON.parse(atob(encoded));
  resetState();
  sets = [];
  if (Array.isArray(raw)) {
    const set = createSet('Build 1', 'imported'); sets = [set]; activeSetId = set.id;
    raw.forEach(entry => { const src = DATA.find(d => d.name === entry.n); if (!src) return; const ti = entry.r || 0; ensureTrack(set, ti); set.tracks[ti].push(makeItem(src, set.id, ti, entry.t || 0)); });
  } else if (raw && Array.isArray(raw.trackSets)) {
    raw.trackSets.forEach(rawSet => {
      const setId = typeof rawSet.id === 'number' ? rawSet.id : nextSetId++;
      nextSetId = Math.max(nextSetId, setId + 1);
      const set = { id: setId, name: rawSet.name || `Build ${setId}`, tracks: [], sourceKind: 'imported' };
      (rawSet.tracks || []).forEach((track, ti) => { set.tracks[ti] = []; track.forEach(entry => { const src = DATA.find(d => d.name === entry.n); if (!src) return; set.tracks[ti].push(makeItem(src, set.id, ti, entry.t || 0, typeof entry.id === 'number' ? entry.id : undefined)); }); });
      if (!set.tracks.length) set.tracks = [[]];
      sets.push(set);
    });
    activeSetId = raw.activeTrackSetId;
  }
  normalizeState();
}
function setFromEmbeddedPayload(payload, fallbackName) {
  const resolvedName = payload && typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : fallbackName;
  const set = createSet(resolvedName, 'embedded');
  set.playerData = payload && payload.playerData && typeof payload.playerData === 'object' ? payload.playerData : null;
  set.economyData = parseEconomyPayload(payload && payload.economyData ? payload.economyData : { samples: [] });
  set.supplyData = parseSupplyPayload(payload && payload.supplyData ? payload.supplyData : { samples: [] });
  set.armyData = parseArmyPayload(payload && payload.armyData ? payload.armyData : { samples: [] });
  set.deathsData = parseDeathsPayload(payload && payload.deathsData ? payload.deathsData : { samples: [] });
  applyBuildOrderText(set, typeof payload.buildOrderText === 'string' ? payload.buildOrderText : '', resolvedName);
  return set;
}
async function setFromBundleZip(zip, fallbackName, sourceKind = 'imported') {
  const playerText = await zip.file('player.json')?.async('string');
  const buildText = await zip.file('build_order.txt')?.async('string');
  const economyText = await zip.file('economy.json')?.async('string');
  const supplyText = await zip.file('supply.json')?.async('string');
  const armyText = await zip.file('unit_counts.json')?.async('string');
  const deathsText = await zip.file('deaths.json')?.async('string');
  if (!playerText || buildText == null || !economyText || !supplyText) {
    throw new Error('Bundle must contain player.json, build_order.txt, economy.json, and supply.json');
  }

  const player = JSON.parse(playerText);
  const name = player.name || fallbackName || `${player.race || 'Player'} ${player.owner}`;
  const set = createSet(name, sourceKind);
  set.playerData = player;
  set.economyData = parseEconomyPayload(JSON.parse(economyText));
  set.supplyData = parseSupplyPayload(JSON.parse(supplyText));
  set.armyData = armyText
    ? parseArmyPayload(JSON.parse(armyText))
    : parseArmyPayload({ samples: [] });
  set.deathsData = deathsText
    ? parseDeathsPayload(JSON.parse(deathsText))
    : parseDeathsPayload({ samples: [] });
  applyBuildOrderText(set, buildText, name);
  return set;
}
function bytesFromBase64(base64Text) {
  const normalized = base64Text.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function clearEmbeddedReplay() {
  if (embeddedReplayUrl) URL.revokeObjectURL(embeddedReplayUrl);
  embeddedReplayUrl = null;
  embeddedReplayName = null;
  if (downloadReplayBtn) downloadReplayBtn.hidden = true;
}
function setEmbeddedReplay(bytes, filename) {
  clearEmbeddedReplay();
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  embeddedReplayUrl = URL.createObjectURL(blob);
  embeddedReplayName = filename || 'replay.rep';
  if (downloadReplayBtn) downloadReplayBtn.hidden = false;
}
async function loadEmbeddedReplay() {
  clearEmbeddedReplay();
  const nodes = [...document.querySelectorAll('script.embedded-build-order-replay')];
  if (!nodes.length) return false;

  for (const node of nodes) {
    const raw = (node.textContent || '').trim();
    if (!raw) continue;
    const format = (node.getAttribute('data-format') || '').trim().toLowerCase();
    const fallbackName = node.getAttribute('data-filename') || node.getAttribute('data-name') || 'replay.rep';
    try {
      if (format === 'zip-base64') {
        if (!window.JSZip) throw new Error('JSZip is not loaded');
        const zip = await window.JSZip.loadAsync(bytesFromBase64(raw));
        const replayEntry = Object.values(zip.files).find(file => !file.dir && /\.rep$/i.test(file.name))
          || Object.values(zip.files).find(file => !file.dir);
        if (!replayEntry) throw new Error('Embedded replay ZIP does not contain a replay file');
        const replayBytes = await replayEntry.async('uint8array');
        const replayName = replayEntry.name.split('/').pop() || fallbackName;
        setEmbeddedReplay(replayBytes, replayName);
        return true;
      }
      if (format === 'base64' || !format) {
        setEmbeddedReplay(bytesFromBase64(raw), fallbackName);
        return true;
      }
      throw new Error(`Unsupported embedded replay format: ${format}`);
    } catch (err) {
      console.error('Could not parse embedded replay payload', err);
    }
  }
  return false;
}
function loadEmbeddedPageMeta() {
  const nodes = [...document.querySelectorAll('script.embedded-build-order-page-meta')];
  for (const node of nodes) {
    try {
      const payload = JSON.parse(node.textContent || '{}');
      if (payload && typeof payload.title === 'string' && payload.title.trim()) {
        applyPageTitle(payload.title);
        return true;
      }
    } catch (err) {
      console.error('Could not parse embedded page metadata', err);
    }
  }
  applyPageTitle(null);
  return false;
}
async function loadEmbeddedDatasets() {
  const nodes = [...document.querySelectorAll('script.embedded-build-order-dataset')];
  if (!nodes.length) return false;

  const loadedSets = [];
  for (const [index, node] of nodes.entries()) {
    const raw = (node.textContent || '').trim();
    if (!raw) continue;
    const fallbackName = node.getAttribute('data-name') || `Embedded ${index + 1}`;
    const format = (node.getAttribute('data-format') || '').trim().toLowerCase();
    try {
      if (format === 'zip-base64') {
        if (!window.JSZip) throw new Error('JSZip is not loaded');
        const zip = await window.JSZip.loadAsync(bytesFromBase64(raw));
        loadedSets.push(await setFromBundleZip(zip, fallbackName, 'embedded'));
      } else {
        loadedSets.push(setFromEmbeddedPayload(JSON.parse(raw), fallbackName));
      }
    } catch (err) {
      console.error('Could not parse embedded build-order dataset', err);
    }
  }

  if (!loadedSets.length) return false;
  sets = loadedSets;
  activeSetId = loadedSets[0].id;
  combatPanelExpanded = loadedSets.some(set => set.deathsData && Array.isArray(set.deathsData.samples) && set.deathsData.samples.length);
  normalizeState();
  return true;
}
async function loadState() {
  resetState();
  persistState();
  loadEmbeddedPageMeta();
  await loadEmbeddedReplay();
  await loadEmbeddedDatasets();
}
function applyBuildOrderText(set, text, name) {
  set.name = name || set.name;
  set.tracks = [[]]; // Start with a single empty track for normalizeSet to fill
  const items = [];
  text.split('\n').forEach(line => {
    const raw = line.trim();
    if (!raw) return;
    const match = raw.match(/^(?:\((\d+)\)\s+)?(-?\d+:\d{2})\s+(.+)$/);
    if (!match) return;
    const trackHint = match[1] != null ? parseInt(match[1], 10) - 1 : 0;
    const secs = parseTime(match[2]);
    if (secs === null) return;
    let chainTime = secs;
    match[3].split(/\s*->\s*/).forEach(rawName => {
      const src = DATA.find(item => item.name.toLowerCase() === rawName.trim().toLowerCase());
      if (!src) return;
      items.push(makeItem(src, set.id, trackHint, chainTime));
      chainTime += src.buildTime;
    });
  });
  
  // Place all items into the first track temporarily and let normalizeSet handle the grouping and packing
  set.tracks[0] = items;
  normalizeSet(set);
}
function parseEconomyPayload(parsed) {
  const samples = parsed && Array.isArray(parsed.samples) ? parsed.samples : [];
  return {
    owner: parsed ? parsed.owner : undefined,
    samples: samples
      .map(sample => {
        const workers = Number(sample.workers);
        const gatheredMinerals = Number(sample.gathered_minerals);
        const gatheredGas = Number(sample.gathered_gas);
        return {
          time_seconds: Number(sample.time_seconds),
          minerals: Number(sample.minerals),
          gas: Number(sample.gas),
          gathered_minerals: Number.isFinite(gatheredMinerals) ? gatheredMinerals : 0,
          gathered_gas: Number.isFinite(gatheredGas) ? gatheredGas : 0,
          workers: Number.isFinite(workers) ? workers : 0,
        };
      })
      .filter(sample =>
        Number.isFinite(sample.time_seconds) &&
        Number.isFinite(sample.minerals) &&
        Number.isFinite(sample.gas))
      .sort((a, b) => a.time_seconds - b.time_seconds),
  };
}
function parseSupplyPayload(parsed) {
  const samples = parsed && Array.isArray(parsed.samples) ? parsed.samples : [];
  return {
    owner: parsed ? parsed.owner : undefined,
    samples: samples
      .map(sample => ({
        time_seconds: Number(sample.time_seconds),
        current: Number(sample.current),
        max: Number(sample.max),
      }))
      .filter(sample =>
        Number.isFinite(sample.time_seconds) &&
        Number.isFinite(sample.current) &&
        Number.isFinite(sample.max))
      .sort((a, b) => a.time_seconds - b.time_seconds),
  };
}
function parseArmyPayload(parsed) {
  const samples = parsed && Array.isArray(parsed.samples) ? parsed.samples : [];

  return {
    owner: parsed ? parsed.owner : undefined,
    race: parsed ? parsed.race : undefined,

    samples: samples
      .map(sample => {
        const counts = sample && sample.counts && typeof sample.counts === "object"
          ? sample.counts
          : {};

        return {
          time_seconds: Number(sample.time_seconds),

          // Keep counts sparse: absent units remain absent.
          counts: Object.fromEntries(
            Object.entries(counts)
              .map(([unit, count]) => [unit, Number(count)])
              .filter(([unit, count]) =>
                typeof unit === "string" &&
                unit.length > 0 &&
                Number.isFinite(count))
          ),
        };
      })
      .filter(sample =>
        Number.isFinite(sample.time_seconds))
      .sort((a, b) => a.time_seconds - b.time_seconds),
  };
}
function parseDeathsPayload(parsed) {
  const samples = parsed && Array.isArray(parsed.samples) ? parsed.samples : [];
  return {
    owner: parsed ? parsed.owner : undefined,
    race: parsed ? parsed.race : undefined,
    samples: samples
      .map((sample, index) => ({
        frame: Number(sample.frame),
        time_seconds: Number(sample.time_seconds),
        owner: sample && sample.death ? sample.death.owner : undefined,
        unit_type: sample && sample.death ? sample.death.unit_type : undefined,
        category: sample && sample.death ? sample.death.category : undefined,
        original_order: index,
      }))
      .filter(sample =>
        Number.isFinite(sample.time_seconds) &&
        typeof sample.category === 'string' &&
        sample.category.length > 0)
      .sort((a, b) => a.time_seconds - b.time_seconds || a.frame - b.frame || a.original_order - b.original_order),
  };
}
function filteredTerminalCombatDeaths(samples) {
  if (!Array.isArray(samples) || samples.length < TERMINAL_DEATH_MIN_COUNT) return samples || [];
  const endTime = samples[samples.length - 1].time_seconds;
  let startIndex = samples.length - 1;
  while (startIndex > 0 && (endTime - samples[startIndex - 1].time_seconds) <= TERMINAL_DEATH_WINDOW_SECS) {
    startIndex -= 1;
  }
  const tail = samples.slice(startIndex).filter(sample => deathCategoryLane(sample.category));
  if (tail.length < TERMINAL_DEATH_MIN_COUNT) return samples;
  if ((tail.length / samples.length) < TERMINAL_DEATH_MIN_FRACTION) return samples;
  const categories = new Set(tail.map(sample => deathCategoryLane(sample.category)).filter(Boolean));
  if (!(categories.has('workers') && categories.has('buildings') && categories.has('units'))) return samples;
  return samples.slice(0, startIndex);
}
function setRace(set) {
  if (set && set.playerData && typeof set.playerData.race === 'string' && set.playerData.race.trim()) {
    return set.playerData.race.trim();
  }
  if (set && set.deathsData && typeof set.deathsData.race === 'string' && set.deathsData.race.trim()) {
    return set.deathsData.race.trim();
  }
  return '';
}
function isDroneBuiltZergStructure(item) {
  return !!item
    && item.race === 'Zerg'
    && item.type === 'Building'
    && normalizeUnitTypeKey(item.builtFrom) === 'drone'
    && Number.isFinite(item.startTime);
}
function classifyCombatDeaths(set) {
  const rawSamples = set && set.deathsData && Array.isArray(set.deathsData.samples)
    ? set.deathsData.samples
    : [];
  if (!rawSamples.length) {
    return { rawSamples: [], suppressedConstructionDroneDeaths: [], combatSamples: [] };
  }

  const normalizedRace = normalizeUnitTypeKey(setRace(set));
  if (normalizedRace !== 'zerg') {
    return {
      rawSamples,
      suppressedConstructionDroneDeaths: [],
      combatSamples: filteredTerminalCombatDeaths(rawSamples),
    };
  }

  const buildingStarts = (set && Array.isArray(set.tracks) ? set.tracks.flat() : [])
    .filter(isDroneBuiltZergStructure)
    .sort((a, b) => a.startTime - b.startTime || a.id - b.id);
  if (!buildingStarts.length) {
    return {
      rawSamples,
      suppressedConstructionDroneDeaths: [],
      combatSamples: filteredTerminalCombatDeaths(rawSamples),
    };
  }

  const candidateDeaths = rawSamples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) =>
      sample.category === 'worker'
      && normalizeUnitTypeKey(sample.unit_type) === 'drone'
      && Number.isFinite(sample.time_seconds))
    .sort((a, b) =>
      a.sample.time_seconds - b.sample.time_seconds
      || a.sample.frame - b.sample.frame
      || a.sample.original_order - b.sample.original_order);

  const suppressedIndexes = new Set();
  for (const building of buildingStarts) {
    const match = candidateDeaths.find(({ sample, index }) =>
      !suppressedIndexes.has(index)
      && sample.time_seconds >= building.startTime
      && sample.time_seconds < (building.startTime + ZERG_CONSTRUCTION_DRONE_MATCH_WINDOW_SECS));
    if (match) suppressedIndexes.add(match.index);
  }

  if (!suppressedIndexes.size) {
    return {
      rawSamples,
      suppressedConstructionDroneDeaths: [],
      combatSamples: filteredTerminalCombatDeaths(rawSamples),
    };
  }

  const suppressedConstructionDroneDeaths = [];
  const combatEligibleSamples = [];
  rawSamples.forEach((sample, index) => {
    if (suppressedIndexes.has(index)) {
      suppressedConstructionDroneDeaths.push(sample);
      return;
    }
    combatEligibleSamples.push(sample);
  });
  return {
    rawSamples,
    suppressedConstructionDroneDeaths,
    combatSamples: filteredTerminalCombatDeaths(combatEligibleSamples),
  };
}
function combatDeathsForSet(set) {
  return classifyCombatDeaths(set).combatSamples;
}
function combatClassificationDebugForSet(set) {
  const classification = classifyCombatDeaths(set);
  return {
    name: set ? set.name : null,
    race: setRace(set),
    buildingStarts: (set && Array.isArray(set.tracks) ? set.tracks.flat() : [])
      .filter(isDroneBuiltZergStructure)
      .map(item => ({
        name: item.name,
        startTime: item.startTime,
        builtFrom: item.builtFrom,
      })),
    rawDroneDeaths: classification.rawSamples
      .filter(sample => sample.category === 'worker' && normalizeUnitTypeKey(sample.unit_type) === 'drone')
      .map(sample => ({
        time_seconds: sample.time_seconds,
        frame: sample.frame,
        original_order: sample.original_order,
      })),
    suppressedConstructionDroneDeaths: classification.suppressedConstructionDroneDeaths
      .map(sample => ({
        time_seconds: sample.time_seconds,
        frame: sample.frame,
        original_order: sample.original_order,
      })),
    combatDroneDeaths: classification.combatSamples
      .filter(sample => sample.category === 'worker' && normalizeUnitTypeKey(sample.unit_type) === 'drone')
      .map(sample => ({
        time_seconds: sample.time_seconds,
        frame: sample.frame,
        original_order: sample.original_order,
      })),
  };
}
function renderRuler2(range) {
  ruler.innerHTML = '';
  const maj = PPS >= 18 ? 10 : PPS >= 8 ? 15 : PPS >= 5 ? 30 : 60;
  const min = PPS >= 18 ? 5 : PPS >= 8 ? 5 : PPS >= 5 ? 10 : 30;
  const startS = Math.floor(range.min / min) * min;
  for (let s = startS; s <= range.max; s += min) {
    const x = (s - range.min) * PPS;
    const isMaj = s % maj === 0;
    const tick = document.createElement('div');
    tick.className = 'tick' + (isMaj ? ' major' : '');
    tick.style.left = x + 'px';
    tick.style.height = isMaj ? '100%' : '35%';
    ruler.appendChild(tick);
    if (isMaj) { const lbl = document.createElement('div'); lbl.className = 'tick-label'; lbl.style.left = x + 'px'; lbl.textContent = fmt(s); ruler.appendChild(lbl); }
  }
  if (range.min < 0) {
    const x0 = (0 - range.min) * PPS;
    const zero = document.createElement('div'); zero.className = 'tick-zero'; zero.style.left = x0 + 'px'; ruler.appendChild(zero);
    const zeroLabel = document.createElement('div'); zeroLabel.className = 'tick-zero-label'; zeroLabel.style.left = x0 + 'px'; zeroLabel.textContent = '0:00'; ruler.appendChild(zeroLabel);
  }
}
function sampleSupplyAt(samples, t) {
  if (!samples.length) return { current: 0, max: 0 };
  if (t <= samples[0].time_seconds) return samples[0];
  let result = samples[0];
  for (const sample of samples) {
    if (sample.time_seconds > t) break;
    result = sample;
  }
  return result;
}
function sampleArmyAt(samples, t) {
  if (!samples.length) return { counts: {} };
  if (t <= samples[0].time_seconds) return samples[0];
  let result = samples[0];
  for (const sample of samples) {
    if (sample.time_seconds > t) break;
    result = sample;
  }
  return result;
}
function isSupplyCapped(sample) {
  return !!sample && sample.max > 0 && sample.current >= sample.max;
}
function supplyStateForSample(sample) {
  if (!sample) return 'sup-zero';
  if (sample.max === 0) return sample.current > 0 ? 'sup-over' : 'sup-zero';
  if (sample.current >= sample.max) return 'sup-capped';
  if (sample.current / sample.max >= 0.9) return 'sup-warn';
  return 'sup-ok';
}
function supplyStateSeverity(state) {
  switch (state) {
    case 'sup-over': return 3;
    case 'sup-capped': return 2;
    case 'sup-warn': return 1;
    default: return 0;
  }
}
function mergeSupplyIntervals(intervals) {
  if (!intervals.length) return [];
  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const prev = merged[merged.length - 1];
    const current = intervals[i];
    if (prev.state === current.state && Math.abs(prev.end - current.start) < 1e-9) {
      prev.end = current.end;
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}
function buildSupplyIntervals(samples, range) {
  if (!samples || !samples.length) return [];
  const points = [{ t: range.min, sample: sampleSupplyAt(samples, range.min) }];
  samples.forEach(sample => {
    if (sample.time_seconds > range.min && sample.time_seconds < range.max) {
      points.push({ t: sample.time_seconds, sample });
    }
  });
  points.push({ t: range.max, sample: sampleSupplyAt(samples, range.max) });
  const intervals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];
    if (next.t <= current.t) continue;
    intervals.push({
      start: current.t,
      end: next.t,
      state: supplyStateForSample(current.sample),
    });
  }
  let merged = mergeSupplyIntervals(intervals);
  merged = merged.map((interval, index, all) => {
    if (interval.state !== 'sup-ok') return interval;
    const prev = all[index - 1];
    const next = all[index + 1];
    if (!prev || !next) return interval;
    if ((interval.end - interval.start) > SUPPLY_GAP_MERGE_SECS) return interval;
    if (supplyStateSeverity(prev.state) === 0 || supplyStateSeverity(next.state) === 0) return interval;
    return {
      ...interval,
      state: supplyStateSeverity(prev.state) >= supplyStateSeverity(next.state) ? prev.state : next.state,
    };
  });
  return mergeSupplyIntervals(merged);
}
function renderSupply(samples, range, width) {
  const row = document.createElement('div'); row.className = 'supply-row'; row.style.width = width + 'px';
  if (!samples || !samples.length) return row;
  const base = document.createElement('div');
  base.className = 'sup-seg sup-ok sup-base';
  base.style.left = '0px';
  base.style.width = width + 'px';
  row.appendChild(base);
  buildSupplyIntervals(samples, range).forEach(interval => {
    if (interval.state === 'sup-ok' || interval.state === 'sup-zero') return;
    const x = (interval.start - range.min) * PPS;
    const segW = (interval.end - interval.start) * PPS;
    if (segW < 1) return;
    const seg = document.createElement('div');
    seg.className = `sup-seg ${interval.state}`;
    seg.style.left = x + 'px';
    seg.style.width = segW + 'px';
    row.appendChild(seg);
  });
  return row;
}
function sampleEconomyAt(samples, t) {
  if (!samples.length) return { minerals: 0, gas: 0, gathered_minerals: 0, gathered_gas: 0 };
  if (t <= samples[0].time_seconds) return samples[0];
  for (let i = 0; i < samples.length - 1; i++) {
    const current = samples[i];
    const next = samples[i + 1];
    if (t > next.time_seconds) continue;
    if (next.time_seconds === current.time_seconds) return next;
    const ratio = (t - current.time_seconds) / (next.time_seconds - current.time_seconds);
    return {
      minerals: current.minerals + (next.minerals - current.minerals) * ratio,
      gas: current.gas + (next.gas - current.gas) * ratio,
      gathered_minerals: current.gathered_minerals + (next.gathered_minerals - current.gathered_minerals) * ratio,
      gathered_gas: current.gathered_gas + (next.gathered_gas - current.gathered_gas) * ratio,
    };
  }
  return samples[samples.length - 1];
}
function sampleEconomyStepAt(samples, t) {
  if (!samples.length) return { minerals: 0, gas: 0, gathered_minerals: 0, gathered_gas: 0, workers: 0 };
  if (t <= samples[0].time_seconds) {
    return {
      minerals: Number.isFinite(samples[0].minerals) ? samples[0].minerals : 0,
      gas: Number.isFinite(samples[0].gas) ? samples[0].gas : 0,
      gathered_minerals: Number.isFinite(samples[0].gathered_minerals) ? samples[0].gathered_minerals : 0,
      gathered_gas: Number.isFinite(samples[0].gathered_gas) ? samples[0].gathered_gas : 0,
      workers: Number.isFinite(samples[0].workers) ? samples[0].workers : 0,
    };
  }
  let result = samples[0];
  for (const sample of samples) {
    if (sample.time_seconds > t) break;
    result = sample;
  }
  return {
    minerals: Number.isFinite(result.minerals) ? result.minerals : 0,
    gas: Number.isFinite(result.gas) ? result.gas : 0,
    gathered_minerals: Number.isFinite(result.gathered_minerals) ? result.gathered_minerals : 0,
    gathered_gas: Number.isFinite(result.gathered_gas) ? result.gathered_gas : 0,
    workers: Number.isFinite(result.workers) ? result.workers : 0,
  };
}
function deathCategoryLane(category) {
  if (category === 'worker') return 'workers';
  if (category === 'unit' || category === 'air') return 'units';
  if (category === 'building') return 'buildings';
  return null;
}
function visibleCombatCategories() {
  const categories = [];
  if (showCombatWorkers) categories.push('workers');
  if (showCombatUnits) categories.push('units');
  if (showCombatBuildings) categories.push('buildings');
  return categories;
}
function syncCombatToggleButtons() {
  if (combatWorkersBtn) combatWorkersBtn.classList.toggle('is-off', !showCombatWorkers);
  if (combatUnitsBtn) combatUnitsBtn.classList.toggle('is-off', !showCombatUnits);
  if (combatBuildingsBtn) combatBuildingsBtn.classList.toggle('is-off', !showCombatBuildings);
}
function renderGasPanel(activeSet, range, width) {
  gasPanelEl.classList.toggle('collapsed', !gasPanelExpanded);
  gasToggleBtn.textContent = gasPanelExpanded ? 'Hide Economy' : 'Show Economy';
  gasSubtitleEl.textContent = activeSet && activeSet.playerData
    ? `Cumulative gathered income for ${activeSet.playerData.name || `owner ${activeSet.playerData.owner}`} (${activeSet.playerData.race || 'unknown'} ${activeSet.playerData.owner})`
    : 'Load a replay-analysis player bundle to graph cumulative gathered minerals and gas.';
  if (!gasPanelExpanded) return;

  gasInnerEl.style.width = (width + GAS_PADDING_X * 2) + 'px';
  gasSvgEl.setAttribute('width', width + GAS_PADDING_X * 2);
  gasSvgEl.setAttribute('height', GAS_GRAPH_H);
  gasSvgEl.innerHTML = '';
  economyHoverUpdate = null;
  economyHoverClear = null;
  if (!syncingPanelScroll) gasScrollEl.scrollLeft = tlScroll.scrollLeft;
  
  const allSamples = sets.flatMap(s => (s.economyData && s.economyData.samples) || []);
  gasEmptyEl.style.display = allSamples.length ? 'none' : 'flex';
  if (!allSamples.length) return;

  const maxValue = Math.max(1, ...allSamples.map(point => Math.max(point.gathered_minerals || 0, point.gathered_gas || 0)));
  const usableH = GAS_GRAPH_H - GAS_PADDING_Y * 2;
  const mapY = value => GAS_PADDING_Y + ((maxValue - value) / maxValue) * usableH;
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };

  [0, Math.round(maxValue / 2), maxValue].filter((value, idx, arr) => arr.indexOf(value) === idx).forEach(value => {
    const y = mapY(value);
    gasSvgEl.appendChild(make('line', { x1: 0, y1: y, x2: width + GAS_PADDING_X * 2, y2: y, class: value === 0 ? 'gas-zero' : 'gas-grid' }));
    const label = make('text', { x: 4, y: Math.max(10, y - 4), class: 'gas-label' });
    label.textContent = `${Math.round(value)}`;
    gasSvgEl.appendChild(label);
  });

  sets.forEach(set => {
    const samples = set.economyData && Array.isArray(set.economyData.samples) ? set.economyData.samples : [];
    if (!samples.length) return;

    const isActive = set.id === activeSet.id;
    const opacity = isActive ? '1.0' : '0.15';
    
    const linePoints = key => samples
      .map(point => `${((point.time_seconds - TL_MIN) * PPS) + GAS_PADDING_X},${mapY(point[key] || 0)}`)
      .join(' ');
    
    gasSvgEl.appendChild(make('polyline', { points: linePoints('gathered_minerals'), class: 'econ-path-minerals', style: `opacity: ${opacity}` }));
    gasSvgEl.appendChild(make('polyline', { points: linePoints('gathered_gas'), class: 'econ-path-gas', style: `opacity: ${opacity}` }));
  });

  const mineralsLegend = make('text', { x: width + GAS_PADDING_X * 2 - 160, y: 15, class: 'econ-legend-minerals' });
  mineralsLegend.textContent = 'Gathered Minerals';
  gasSvgEl.appendChild(mineralsLegend);
  const gasLegend = make('text', { x: width + GAS_PADDING_X * 2 - 116, y: 15, class: 'econ-legend-gas' });
  gasLegend.textContent = 'Gathered Gas';
  gasSvgEl.appendChild(gasLegend);

  const hoverLine = make('line', { class: 'gas-hover-line', x1: 0, y1: 0, x2: 0, y2: GAS_GRAPH_H, visibility: 'hidden' });
  const hoverBg = make('rect', {
    class: 'gas-hover-bg',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rx: 3,
    ry: 3,
    visibility: 'hidden',
    fill: '#1c1c1c',
    stroke: '#2a2a2a',
    'stroke-width': 1,
  });
  const hoverLabel = make('text', {
    class: 'gas-hover-label',
    x: 0,
    y: 0,
    visibility: 'hidden',
    fill: '#aaa',
    'font-size': 12,
    'font-family': 'monospace',
  });
  gasSvgEl.appendChild(hoverLine);
  gasSvgEl.appendChild(hoverBg);
  gasSvgEl.appendChild(hoverLabel);

  const showHoverAtTime = t => {
    const clampedX = Math.max(GAS_PADDING_X, Math.min(width + GAS_PADDING_X, ((t - TL_MIN) * PPS) + GAS_PADDING_X));
    const samples = activeSet && activeSet.economyData && activeSet.economyData.samples ? activeSet.economyData.samples : [];
    if (!samples.length) { hideHover(); return; }
    
    const sample = sampleEconomyAt(samples, t);
    const y = mapY(Math.max(sample.gathered_minerals, sample.gathered_gas));
    const labelText = `${fmt(Math.round(t))}  🔷 ${Math.round(sample.gathered_minerals)}  🟩 ${Math.round(sample.gathered_gas)}`;

    hoverLine.setAttribute('x1', clampedX);
    hoverLine.setAttribute('x2', clampedX);
    hoverLine.setAttribute('y1', 0);
    hoverLine.setAttribute('y2', GAS_GRAPH_H);
    hoverLine.setAttribute('visibility', 'visible');

    hoverLabel.textContent = labelText;
    hoverLabel.setAttribute('visibility', 'visible');
    hoverLabel.setAttribute('x', 0);
    hoverLabel.setAttribute('y', 0);
    const labelBox = hoverLabel.getBBox();
    const labelX = Math.max(6, Math.min(clampedX + 10, width + GAS_PADDING_X * 2 - labelBox.width - 10));
    const labelY = y < 24 ? y + 18 : y - 10;
    hoverLabel.setAttribute('x', labelX);
    hoverLabel.setAttribute('y', labelY);
    const adjustedBox = hoverLabel.getBBox();
    hoverBg.setAttribute('x', adjustedBox.x - 6);
    hoverBg.setAttribute('y', adjustedBox.y - 4);
    hoverBg.setAttribute('width', adjustedBox.width + 12);
    hoverBg.setAttribute('height', adjustedBox.height + 8);
    hoverBg.setAttribute('visibility', 'visible');
  };
  const hideHover = () => {
    hoverLine.setAttribute('visibility', 'hidden');
    hoverBg.setAttribute('visibility', 'hidden');
    hoverLabel.setAttribute('visibility', 'hidden');
  };
  economyHoverUpdate = showHoverAtTime;
  economyHoverClear = hideHover;
  const showHover = event => {
    const rect = gasSvgEl.getBoundingClientRect();
    const rawX = event.clientX - rect.left;
    const clampedX = Math.max(GAS_PADDING_X, Math.min(width + GAS_PADDING_X, rawX));
    const t = ((clampedX - GAS_PADDING_X) / PPS) + TL_MIN;
    showSharedHover(t, 'economy');
  };
  gasSvgEl.onmousemove = showHover;
  gasSvgEl.onmouseleave = () => hideSharedHover('economy');
}
function renderCombatPanel(range, width) {
  combatPanelEl.classList.toggle('collapsed', !combatPanelExpanded);
  combatToggleBtn.textContent = combatPanelExpanded ? 'Hide Combat' : 'Show Combat';
  syncCombatToggleButtons();
  syncCombatCopyUi();
  combatHoverUpdate = null;
  combatHoverClear = null;
  if (combatBodyEl) combatBodyEl.style.height = `${combatBodyHeight}px`;

  const categories = visibleCombatCategories();
  const allDeathSamples = sets.flatMap(set => combatDeathsForSet(set));
  combatSubtitleEl.textContent = allDeathSamples.length
    ? 'Replay death heatmap for loaded players, bucketed into 5-second combat lanes.'
    : 'Import player data with deaths.json to graph losses across time.';

  if (!combatPanelExpanded) return;

  if (!syncingPanelScroll) combatScrollEl.scrollLeft = tlScroll.scrollLeft;
  combatInnerEl.style.width = width + 'px';
  combatSectionsEl.style.width = width + 'px';
  combatLabelSectionsEl.style.transform = `translateY(${-combatScrollEl.scrollTop}px)`;
  combatLabelSectionsEl.innerHTML = '';
  combatSectionsEl.innerHTML = '';

  if (!categories.length) {
    combatEmptyEl.textContent = 'Enable at least one combat lane to render the heatmap';
    combatEmptyEl.style.display = 'flex';
    return;
  }
  if (!allDeathSamples.length) {
    combatEmptyEl.textContent = 'Import player data with deaths.json to compare combat losses';
    combatEmptyEl.style.display = 'flex';
    return;
  }

  const bucketCount = Math.max(1, Math.ceil((range.max - range.min) / COMBAT_BUCKET_SECS));
  const categoryCountsBySet = sets.map(set => {
    const samples = combatDeathsForSet(set);
    const counts = {
      workers: new Array(bucketCount).fill(0),
      units: new Array(bucketCount).fill(0),
      buildings: new Array(bucketCount).fill(0),
    };
    const details = {
      workers: Array.from({ length: bucketCount }, () => []),
      units: Array.from({ length: bucketCount }, () => []),
      buildings: Array.from({ length: bucketCount }, () => []),
    };
    samples.forEach(sample => {
      const lane = deathCategoryLane(sample.category);
      if (!lane) return;
      const bucketIndex = Math.floor((sample.time_seconds - range.min) / COMBAT_BUCKET_SECS);
      if (bucketIndex < 0 || bucketIndex >= bucketCount) return;
      counts[lane][bucketIndex] += 1;
      details[lane][bucketIndex].push(sample);
    });
    return { set, samples, counts, details, totalDeaths: samples.filter(sample => deathCategoryLane(sample.category)).length };
  });

  const maxBucketValue = Math.max(1, ...categoryCountsBySet.flatMap(entry => categories.flatMap(category => entry.counts[category])));
  const bucketWidth = Math.max(1, COMBAT_BUCKET_SECS * PPS);
  combatEmptyEl.style.display = 'none';

  const hoverLine = document.createElement('div');
  hoverLine.className = 'combat-hover-line';
  combatSectionsEl.appendChild(hoverLine);

  categoryCountsBySet.forEach(entry => {
    const labelSet = document.createElement('div');
    labelSet.className = 'combat-label-set';

    const labelHeader = document.createElement('div');
    labelHeader.className = 'combat-label-header';
    labelHeader.textContent = entry.set.name;
    labelSet.appendChild(labelHeader);

    const section = document.createElement('div');
    section.className = 'combat-set';

    const header = document.createElement('div');
    header.className = 'combat-set-header';
    header.innerHTML = `<strong>${entry.totalDeaths} deaths</strong><span>${categories.length} lanes</span>`;
    section.appendChild(header);

    categories.forEach(category => {
      const label = document.createElement('div');
      label.className = 'combat-label-row';
      label.textContent = `${entry.set.name} ${category}`;
      labelSet.appendChild(label);

      const row = document.createElement('div');
      row.className = 'combat-row';

      const track = document.createElement('div');
      track.className = 'combat-row-track';
      track.style.width = width + 'px';
      track.dataset.setId = String(entry.set.id);
      track.dataset.category = category;

      entry.counts[category].forEach((count, idx) => {
        if (!count) return;
        const cell = document.createElement('div');
        cell.className = `combat-bucket ${category}`;
        cell.style.left = (idx * bucketWidth) + 'px';
        cell.style.width = Math.max(2, bucketWidth - 1) + 'px';
        cell.style.opacity = String(0.14 + (count / maxBucketValue) * 0.86);
        track.appendChild(cell);
      });

      row.appendChild(track);
      section.appendChild(row);
    });

    combatLabelSectionsEl.appendChild(labelSet);
    combatSectionsEl.appendChild(section);
  });

  const showHoverAtTime = t => {
    const x = Math.max(0, Math.min(width, (t - TL_MIN) * PPS));
    hoverLine.style.left = x + 'px';
    hoverLine.style.visibility = 'visible';
  };
  const hideHover = () => {
    hoverLine.style.visibility = 'hidden';
  };
  combatHoverUpdate = showHoverAtTime;
  combatHoverClear = hideHover;

  combatSectionsEl.onmousemove = event => {
    const rect = combatScrollEl.getBoundingClientRect();
    const rawX = event.clientX - rect.left + combatScrollEl.scrollLeft;
    const clampedX = Math.max(0, Math.min(width, rawX));
    const time = (clampedX / PPS) + TL_MIN;
    const hoveredTrack = event.target.closest('.combat-row-track');
    if (hoveredTrack) {
      const setId = Number(hoveredTrack.dataset.setId);
      const category = hoveredTrack.dataset.category;
      const bucketIndex = Math.max(0, Math.min(bucketCount - 1, Math.floor((time - range.min) / COMBAT_BUCKET_SECS)));
      const entry = categoryCountsBySet.find(item => item.set.id === setId);
      const bucketSamples = entry ? entry.details[category][bucketIndex] : [];
      const ctrlHeld = isKeyHeld('ControlLeft') || isKeyHeld('ControlRight');
      if (ctrlHeld) {
        tipEl.classList.add('tip-multicol');
        tipEl.innerHTML = renderCombatCumulativeTooltip(categoryCountsBySet, time);
        tipEl.style.display = 'flex';
        moveTip(event);
      } else if (bucketSamples && bucketSamples.length) {
        tipEl.classList.remove('tip-multicol');
        const countsByUnit = new Map();
        bucketSamples.forEach(sample => {
          const key = sample.unit_type || 'unknown';
          countsByUnit.set(key, (countsByUnit.get(key) || 0) + 1);
        });
        const lines = [...countsByUnit.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([unitType, count]) => {
            const label = pluralizeUnitLabel(titleizeUnitType(unitType), count);
            return `<li>${count} ${escapeHtml(label)}</li>`;
          })
          .join('');
        const bucketStart = range.min + bucketIndex * COMBAT_BUCKET_SECS;
        const bucketEnd = bucketStart + COMBAT_BUCKET_SECS;
        tipEl.innerHTML = `<b style="color:#fff">${escapeHtml(entry.set.name)} ${escapeHtml(category)} lost</b><br><span style="color:#555">${fmt(Math.round(bucketStart))} - ${fmt(Math.round(bucketEnd))}</span><ul class="timeline-hover-army">${lines}</ul>`;
        tipEl.style.display = 'block';
        moveTip(event);
      } else {
        hideTip();
      }
    } else {
      hideTip();
    }
    showSharedHover(time, 'combat', {
      rich: isKeyHeld('ShiftLeft') || isKeyHeld('ShiftRight'),
      gathered: false,
    }, event);
  };
  combatSectionsEl.onmouseleave = () => { hideTip(); hideSharedHover('combat'); };
}
function renderTimelineHoverTooltip(time, options = {}) {
  return sets.map(set => {
    const economySamples = set.economyData && Array.isArray(set.economyData.samples) ? set.economyData.samples : [];
    const bank = sampleEconomyStepAt(economySamples, time);
    const supplySamples = set.supplyData && Array.isArray(set.supplyData.samples) ? set.supplyData.samples : [];
    const supply = sampleSupplyAt(supplySamples, time);
    const armySamples = set.armyData && Array.isArray(set.armyData.samples) ? set.armyData.samples : [];
    const army = sampleArmyAt(armySamples, time);
    const armyList = Object.entries(army.counts || {})
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([unitName, count]) => `<li>${formatRounded(count)}x ${escapeHtml(unitName)}</li>`)
      .join('');
    const armyHtml = armyList
      ? `<ul class="timeline-hover-army">${armyList}</ul>`
      : '<div class="timeline-hover-empty">No army data</div>';
    const metaText = set.playerData && set.playerData.race
      ? `${set.playerData.race} replay data`
      : 'Timeline snapshot';
    const gatheredLine = options.gathered
      ? `<div class="timeline-hover-statline"><span class="timeline-hover-icon">Σ🔷</span> ${formatRounded(bank.gathered_minerals)} <span class="timeline-hover-icon">Σ🟩</span> ${formatRounded(bank.gathered_gas)}</div>`
      : '';
    const armySection = options.rich ? armyHtml : '';

    return `<div class="timeline-hover-player-col">`
      + `<div class="timeline-hover-heading"><strong>${escapeHtml(set.name)}</strong><span class="timeline-hover-time">${fmt(Math.round(time))}</span></div>`
      + `<div class="timeline-hover-meta">${escapeHtml(metaText)}</div>`
      + `<div class="timeline-hover-statline"><span class="timeline-hover-icon">🔷</span> ${formatRounded(bank.minerals)} <span class="timeline-hover-icon">🟩</span> ${formatRounded(bank.gas)}</div>`
      + `<div class="timeline-hover-statline"><span class="timeline-hover-icon">👷</span> ${formatRounded(bank.workers)} <span class="timeline-hover-icon">#️⃣</span> ${formatRounded(supply.current)}/${formatRounded(supply.max)}</div>`
      + `${gatheredLine}`
      + `${armySection}`
      + `</div>`;
  }).join('');
}
function showTimelineHover(time, options = {}, event = null) {
  if (!timelineHoverLine || !timelineHoverLabel) return;
  const x = (time - TL_MIN) * PPS;
  timelineHoverLine.style.left = x + 'px';
  timelineHoverLine.style.visibility = 'visible';

  if (!options.rich && !options.gathered) {
    const set = activeSet();
    if (!set) return;
    const supplySamples = set.supplyData && Array.isArray(set.supplyData.samples) ? set.supplyData.samples : [];
    const supply = sampleSupplyAt(supplySamples, time);
    timelineHoverLabel.textContent = supplySamples.length
      ? `${fmt(Math.round(time))}  SUP ${formatRounded(supply.current)}/${formatRounded(supply.max)}`
      : `${fmt(Math.round(time))}`;
    timelineHoverLabel.style.visibility = 'visible';
    timelineHoverLabel.style.left = (event ? event.clientX + 14 : x + 10) + 'px';
    timelineHoverLabel.style.top = (event ? event.clientY - 8 : 32) + 'px';
    return;
  }
  timelineHoverLabel.innerHTML = renderTimelineHoverTooltip(time, options);
  timelineHoverLabel.style.visibility = 'visible';
  timelineHoverLabel.style.left = (event ? event.clientX + 14 : x + 10) + 'px';
  timelineHoverLabel.style.top = (event ? event.clientY - 8 : 32) + 'px';
  return;
}
function hideTimelineHover() {
  if (!timelineHoverLine || !timelineHoverLabel) return;
  timelineHoverLine.style.visibility = 'hidden';
  timelineHoverLabel.style.visibility = 'hidden';
  timelineHoverLabel.textContent = '';
}
function showSharedHover(time, source = 'timeline', options = {}, event = null) {
  showTimelineHover(time, options, event);
  if (combatHoverUpdate) combatHoverUpdate(time);
}
function hideSharedHover(source = 'timeline') {
  hideTimelineHover();
  if (combatHoverClear) combatHoverClear();
}
boText.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeBoImportModal();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    window.parseAndApply();
  }
});
if (importPlayerDataBtn && bundleFileInput) {
  importPlayerDataBtn.addEventListener('click', () => bundleFileInput.click());
}
if (analysisCopyBtnEl && analysisCopyWrapEl) {
  analysisCopyBtnEl.dataset.defaultLabel = analysisCopyBtnEl.textContent;
  analysisCopyBtnEl.addEventListener('click', event => {
    if (analysisCopyBtnEl.disabled) return;
    event.stopPropagation();
    const nextOpen = !analysisCopyWrapEl.classList.contains('open');
    analysisCopyWrapEl.classList.toggle('open', nextOpen);
    analysisCopyBtnEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  });
  analysisCopyWrapEl.addEventListener('click', event => event.stopPropagation());
}
if (analysisCopyFullBtnEl) {
  analysisCopyFullBtnEl.addEventListener('click', () => copyFullAnalysisReport());
}
if (analysisCopyPromptBtnEl) {
  analysisCopyPromptBtnEl.addEventListener('click', () => copyPromptAndAnalysisReport());
}
if (boMoreBtnEl && boMoreWrapEl) {
  boMoreBtnEl.addEventListener('click', event => {
    event.stopPropagation();
    const nextOpen = !boMoreWrapEl.classList.contains('open');
    boMoreWrapEl.classList.toggle('open', nextOpen);
    boMoreBtnEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  });
  boMoreWrapEl.addEventListener('click', event => event.stopPropagation());
}
if (combatCopyBtnEl && combatCopyWrapEl) {
  combatCopyBtnEl.dataset.defaultLabel = combatCopyBtnEl.textContent;
  combatCopyBtnEl.addEventListener('click', event => {
    if (combatCopyBtnEl.disabled) return;
    event.stopPropagation();
    const nextOpen = !combatCopyWrapEl.classList.contains('open');
    combatCopyWrapEl.classList.toggle('open', nextOpen);
    combatCopyBtnEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  });
  combatCopyWrapEl.addEventListener('click', event => event.stopPropagation());
}
if (combatCopyFocusedBtnEl) {
  combatCopyFocusedBtnEl.addEventListener('click', () => copyCombatLedger('focused'));
}
if (combatCopyAllBtnEl) {
  combatCopyAllBtnEl.addEventListener('click', () => copyCombatLedger('all'));
}
bindStaticUiActions();
document.addEventListener('click', () => {
  closeAnalysisCopyMenu();
  closeBoMoreMenu();
  closeCombatCopyMenu();
});
tlScroll.addEventListener('scroll', () => {
  if (syncingPanelScroll) return;
  syncingPanelScroll = true;
  combatScrollEl.scrollLeft = tlScroll.scrollLeft;
  syncingPanelScroll = false;
});
ruler.addEventListener('mousemove', event => {
  const rect = tlScroll.getBoundingClientRect();
  const rawX = event.clientX - rect.left + tlScroll.scrollLeft;
  const clampedX = Math.max(0, Math.min(tlInner.clientWidth, rawX));
  const time = (clampedX / PPS) + TL_MIN;
  showSharedHover(time, 'timeline', {
    rich: isKeyHeld('ShiftLeft') || isKeyHeld('ShiftRight'),
    gathered: isKeyHeld('ControlLeft') || isKeyHeld('ControlRight'),
  }, event);
});
ruler.addEventListener('mouseleave', event => hideSharedHover('timeline'));
tlScroll.addEventListener('mousemove', event => {
  const rect = tlScroll.getBoundingClientRect();
  const rawX = event.clientX - rect.left + tlScroll.scrollLeft;
  const clampedX = Math.max(0, Math.min(tlInner.clientWidth, rawX));
  const time = (clampedX / PPS) + TL_MIN;
  showSharedHover(time, 'timeline', {
    rich: isKeyHeld('ShiftLeft') || isKeyHeld('ShiftRight'),
    gathered: isKeyHeld('ControlLeft') || isKeyHeld('ControlRight'),
  }, event);
});
tlScroll.addEventListener('mouseleave', () => hideSharedHover('timeline'));
combatResizeHandleEl.addEventListener('mousedown', event => {
  event.preventDefault();
  const startHeight = combatBodyEl ? combatBodyEl.getBoundingClientRect().height : combatBodyHeight;
  combatResizeState = {
    startY: event.clientY,
    startHeight,
  };
});
combatScrollEl.addEventListener('scroll', () => {
  combatLabelSectionsEl.style.transform = `translateY(${-combatScrollEl.scrollTop}px)`;
  if (syncingPanelScroll) return;
  syncingPanelScroll = true;
  tlScroll.scrollLeft = combatScrollEl.scrollLeft;
  syncingPanelScroll = false;
});
window.addEventListener('mousemove', event => {
  if (!combatResizeState || !combatBodyEl) return;
  const mainEl = document.getElementById('main');
  const maxHeight = Math.max(COMBAT_BODY_MIN_HEIGHT, (mainEl ? mainEl.clientHeight : window.innerHeight) - 120);
  const nextHeight = Math.max(
    COMBAT_BODY_MIN_HEIGHT,
    Math.min(maxHeight, combatResizeState.startHeight - (event.clientY - combatResizeState.startY)),
  );
  combatBodyHeight = nextHeight;
  combatBodyEl.style.height = `${combatBodyHeight}px`;
});
window.addEventListener('mouseup', () => {
  combatResizeState = null;
});
bundleFileInput.addEventListener('change', event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      if (!window.JSZip) throw new Error('JSZip is not loaded');
      const zip = await window.JSZip.loadAsync(reader.result);
      const set = await setFromBundleZip(zip, file.name.replace(/\.zip$/i, '') || `Player ${sets.length + 1}`, 'imported');
      
      sets.push(set);
      activeSetId = set.id;
      if (set.deathsData && Array.isArray(set.deathsData.samples) && set.deathsData.samples.length) combatPanelExpanded = true;
      window.render();
      persistState();
    } catch (err) {
      console.error(err);
      combatSubtitleEl.textContent = `Could not import player data: ${err.message || err}`;
      window.render(true);
    } finally {
      bundleFileInput.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
});
function makeBlock(item) {
  const block = document.createElement('div');
  block.className = 'bl';
  if (selectedIds.has(item.id)) block.classList.add('sel');
  block.dataset.id = item.id;
  block.style.left = ((item.startTime - TL_MIN) * PPS) + 'px';
  block.style.width = Math.max(item.buildTime * PPS - 2, 6) + 'px';
  block.style.background = RACE_BG[item.race];
  block.style.borderLeft = `2px ${item.type === 'Upgrade' ? 'dashed' : 'solid'} ${RACE_COLOR[item.race]}`;
  block.style.color = RACE_COLOR[item.race];
  if (item.type === 'Upgrade') block.style.opacity = '0.85';
  const label = document.createElement('span'); label.textContent = item.name; block.appendChild(label);
  block.addEventListener('mousedown', event => handleBlockMouseDown(event, item));
  block.addEventListener('mouseenter', event => showTip(event, item));
  block.addEventListener('mousemove', moveTip);
  block.addEventListener('mouseleave', hideTip);
  block.addEventListener('contextmenu', event => { event.preventDefault(); selectedIds = new Set([item.id]); showContext(event, item.id); window.render(true); });
  return block;
}
function renderSections(range, width) {
  labelList.innerHTML = ''; tracksRoot.innerHTML = '';
  sets.forEach(set => {
    const showSupply = !!(set.supplyData && Array.isArray(set.supplyData.samples) && set.supplyData.samples.length);
    const labelSection = document.createElement('div');
    const labelHeader = document.createElement('div'); labelHeader.className = 'label-set-header' + (set.id === activeSetId ? ' active' : ''); labelHeader.textContent = set.name; labelSection.appendChild(labelHeader);
    if (showSupply) { const labelSupply = document.createElement('div'); labelSupply.className = 'label-supply-cell'; labelSupply.textContent = 'SUP'; labelSection.appendChild(labelSupply); }
    
    const visibleTracks = set.tracks.map((items, ti) => ({ items, ti })).filter(t => {
      if (showUnits) return true;
      return t.items.some(item => item.type !== 'Unit');
    });

    visibleTracks.forEach(t => {
      const cell = document.createElement('div');
      cell.className = 'label-cell';
      cell.textContent = `T${t.ti + 1}`;
      labelSection.appendChild(cell);
    });

    const dropCell = document.createElement('div'); dropCell.className = 'label-drop-cell'; dropCell.textContent = '+'; labelSection.appendChild(dropCell); labelList.appendChild(labelSection);
    const section = document.createElement('div'); section.className = 'tracks-section'; section.style.width = width + 'px';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'set-section-header' + (set.id === activeSetId ? ' active' : '');
    header.setAttribute('aria-pressed', set.id === activeSetId ? 'true' : 'false');
    header.setAttribute('aria-label', `Focus ${set.name}`);
    header.onclick = () => window.switchActiveTrackSet(set.id);
    const title = document.createElement('span'); title.textContent = set.name; const meta = document.createElement('span'); meta.className = 'set-section-meta'; meta.textContent = `${set.tracks.filter(track => track.length).length || 1} tracks`; header.appendChild(title); header.appendChild(meta); section.appendChild(header);
    if (showSupply) section.appendChild(renderSupply(set.supplyData.samples, range, width));
    
    visibleTracks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.dataset.setId = set.id;
      row.dataset.ti = t.ti;
      t.items.forEach(item => {
        if (!showUnits && item.type === 'Unit') return;
        row.appendChild(makeBlock(item));
      });
      section.appendChild(row);
    });
    const dropRow = document.createElement('div'); dropRow.className = 'track-drop-row' + (set.id === activeSetId ? ' active' : ''); dropRow.dataset.setId = set.id; dropRow.dataset.ti = set.tracks.length; section.appendChild(dropRow); tracksRoot.appendChild(section);
  });
}
function handleBlockMouseDown(event, item) {
  if (event.button !== 0) return;
  if (event.ctrlKey || event.metaKey) { event.preventDefault(); if (selectedIds.has(item.id)) selectedIds.delete(item.id); else selectedIds.add(item.id); window.render(true); return; }
  selectedIds = new Set([item.id]); startDrag(event, item);
}
function startDrag(event, anchorItem) {
  event.preventDefault(); hideTip();
  const anchorEl = event.currentTarget; const rect = anchorEl.getBoundingClientRect(); const set = sets.find(entry => entry.id === anchorItem.trackSetId);
  anchorEl.classList.add('dragging');
  ghostEl.style.display = 'flex'; ghostEl.style.width = anchorEl.style.width; ghostEl.style.background = anchorEl.style.background; ghostEl.style.borderLeft = anchorEl.style.borderLeft; ghostEl.style.color = anchorEl.style.color; ghostEl.innerHTML = `<span id="ghost-name">${anchorItem.name}</span><span id="ghost-time"></span>`;
  dragState = { setId: set.id, anchorItem, anchorEl, offX: event.clientX - rect.left, plan: null };
  document.addEventListener('mousemove', moveDrag); document.addEventListener('mouseup', endDrag);
}
function moveDrag(event) {
  if (!dragState) return;
  const tracksRect = tracksRoot.getBoundingClientRect(), scrollRect = tlScroll.getBoundingClientRect(), relX = event.clientX - tracksRect.left + tlScroll.scrollLeft - dragState.offX, sec = Math.round(relX / PPS + TL_MIN);
  const hovered = document.elementFromPoint(event.clientX, event.clientY), row = hovered && hovered.closest('.track-row, .track-drop-row'), set = sets.find(entry => entry.id === dragState.setId), targetTrack = row && Number(row.dataset.setId) === dragState.setId ? Number(row.dataset.ti) : dragState.anchorItem.trackIndex;

  const tempTracks = set.tracks.map(track => track.filter(item => item.id !== dragState.anchorItem.id).slice());
  while (tempTracks.length <= targetTrack) tempTracks.push([]);
  if (overlaps2(tempTracks[targetTrack], sec, dragState.anchorItem.buildTime)) {
    dragState.plan = null;
  } else {
    dragState.plan = { startTime: sec, trackIndex: targetTrack };
  }

  const rowRect = row && Number(row.dataset.setId) === dragState.setId ? row.getBoundingClientRect() : document.querySelector(`.track-row[data-set-id="${dragState.setId}"][data-ti="${Math.min(targetTrack, set.tracks.length - 1)}"]`)?.getBoundingClientRect();
  ghostEl.style.left = (tracksRect.left - tlScroll.scrollLeft + (sec - TL_MIN) * PPS) + 'px'; ghostEl.style.top = ((rowRect ? rowRect.top : tracksRect.top) + 3) + 'px';
  const ghostTime = document.getElementById('ghost-time'); if (ghostTime) { ghostTime.textContent = `${fmt(sec)} -> ${fmt(sec + dragState.anchorItem.buildTime)}`; }
  if (event.clientX > scrollRect.right - 50) tlScroll.scrollLeft += 10; if (event.clientX < scrollRect.left + 50) tlScroll.scrollLeft -= 10; if (event.clientY > scrollRect.bottom - 40) tlScroll.scrollTop += 10; if (event.clientY < scrollRect.top    + 40) tlScroll.scrollTop -= 10;
}
function endDrag() {
  if (!dragState) return;
  const set = sets.find(entry => entry.id === dragState.setId);
  if (dragState.plan) {
    set.tracks = set.tracks.map(track => track.filter(item => item.id !== dragState.anchorItem.id));
    dragState.anchorItem.startTime = dragState.plan.startTime;
    dragState.anchorItem.trackIndex = dragState.plan.trackIndex;
    ensureTrack(set, dragState.anchorItem.trackIndex);
    set.tracks[dragState.anchorItem.trackIndex].push(dragState.anchorItem);
    normalizeSet(set); persistState();
  }
  ghostEl.style.display = 'none'; dragState.anchorEl.classList.remove('dragging'); dragState = null; document.removeEventListener('mousemove', moveDrag); document.removeEventListener('mouseup', endDrag); window.render(true);
}
function showTip(event, item) {
  const endTime = item.startTime + item.buildTime;
  const set = sets.find(s => s.id === item.trackSetId) || activeSet();
  if (!set) return;
  const economySamples = set.economyData && Array.isArray(set.economyData.samples) ? set.economyData.samples : [];
  
  const bankLine = economySamples.length
  ? (() => {
    const bank = sampleEconomyStepAt(economySamples, item.startTime);
    const supplySamples = set.supplyData && Array.isArray(set.supplyData.samples) ? set.supplyData.samples : [];
    const supply = sampleSupplyAt(supplySamples, item.startTime);
    return `<br><span style="color:#555">bank</span> <b style="color:#ddd">🔷 ${Math.round(bank.minerals)} 🟩 ${Math.round(bank.gas)} 👷 ${Math.round(bank.workers)} #️⃣ ${supply.current}/${supply.max}</b>`;
  })()
  : '';
  const supplyChunk = item.supplyCost > 0 ? `#️⃣ <b style="color:#ddd">${item.supplyCost}</b>` : '';
  const costLine = `<span style="color:#555">cost</span> 🔷 <b style="color:#ddd">${item.mineralCost}</b> 🟩 <b style="color:#ddd">${item.gasCost}</b> ${supplyChunk}`;
  tipEl.innerHTML = `<b style="color:#fff">${item.name}</b> <span style="color:#444">${item.race} ${item.type}</span><br><span style="color:#555">start</span> <b style="color:#f0c040">${fmt(item.startTime)}</b> -> <span style="color:#555">end</span> <b style="color:#f0c040">${fmt(endTime)}</b><br><span style="color:#444">build time ${item.buildTime}s</span><br>${costLine}${bankLine}`;
  tipEl.style.display = 'block'; moveTip(event);
}
function moveTip(event) {
  const pad = 10;
  const defaultLeft = event.clientX + 14;
  const defaultTop = event.clientY - 8;
  const tipWidth = tipEl.offsetWidth || 0;
  const tipHeight = tipEl.offsetHeight || 0;
  const maxLeft = Math.max(pad, window.innerWidth - tipWidth - pad);
  const maxTop = Math.max(pad, window.innerHeight - tipHeight - pad);
  const left = Math.min(defaultLeft, maxLeft);
  const top = defaultTop + tipHeight + pad > window.innerHeight
    ? Math.max(pad, event.clientY - tipHeight - 14)
    : Math.max(pad, defaultTop);
  tipEl.style.left = left + 'px';
  tipEl.style.top = Math.min(top, maxTop) + 'px';
}
function hideTip() {
  tipEl.style.display = 'none';
  tipEl.classList.remove('tip-multicol');
}
let ctxId2 = null; function showContext(event, id) { ctxId2 = id; ctxEl.style.left = event.clientX + 'px'; ctxEl.style.top = event.clientY + 'px'; ctxEl.style.display = 'block'; }
document.getElementById('ctx-remove').onclick = () => { if (ctxId2 != null) window.removeItem(ctxId2); ctxEl.style.display = 'none'; ctxId2 = null; };
window.render = function renderForge(skipBO = false) {
  normalizeState();
  const range = timeRange2();
  const set = activeSet();
  TL_MIN = range.min;
  const width = (range.max - range.min) * PPS;
  tlInner.style.width = width + 'px'; tracksRoot.style.width = width + 'px'; ruler.style.width = width + 'px'; hiddenSupply.style.width = width + 'px'; hiddenLabelSupply.style.display = 'none';
  timelineEmptyEl.style.display = sets.length ? 'none' : 'flex';
  syncAnalysisCopyUi();
  renderAnalysisStatus();
  if (timelineSubtitleEl) timelineSubtitleEl.textContent = sets.length
    ? 'Compare loaded player analysis data across build order, supply, and combat.'
    : 'No analysis data loaded. Import player data to compare build and combat timelines.';
  renderRuler2(range); renderSections(range, width);
  renderCombatPanel(range, width);
  const unitToggleBtn = document.getElementById('unit-toggle-btn');
  if (unitToggleBtn) unitToggleBtn.textContent = showUnits ? 'Hide Units' : 'Show Units';
  window.updateBO();
  document.getElementById('zoom-info').textContent = PPS + 'px/s'; applyPageTitle(embeddedPageTitle);
};
window.addItem = function addItemForge(dataItem) {
  let set = activeSet();
  if (!set) {
    set = createSet(`Build ${nextSetId}`);
    sets.push(set);
    activeSetId = set.id;
  }
  set.tracks[0].push(makeItem(dataItem, set.id, 0, 0));
  normalizeSet(set);
  window.render();
  persistState();
};
window.removeItem = function removeItemForge(id) {
  const found = findItem(id); if (!found) return;
  found.set.tracks[found.trackIndex] = found.set.tracks[found.trackIndex].filter(item => item.id !== id);
  selectedIds.delete(id); normalizeSet(found.set); window.render(); persistState();
};
window.updateBO = function updateBOForge() {
  renderBuildOrderTable();
};
window.zoom = function zoomForge(dir) { zoomIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoomIdx + dir)); PPS = ZOOM_STEPS[zoomIdx]; window.render(true); };
window.clearAll = function clearAllForge() { resetState(); window.render(); persistState(); };
window.saveURL = persistState; window.decodeState = decodeState2; window.loadURL = loadState;
window.addTrackSet = function addTrackSetForge() { const name = prompt('New player name:', `Player ${sets.length + 1}`); if (!name || !name.trim()) return; const set = createSet(name.trim(), 'imported'); sets.push(set); activeSetId = set.id; selectedIds = new Set(); window.render(); persistState(); };
window.renameActiveTrackSet = function renameTrackSetForge() { const set = activeSet(); if (!set) return; const name = prompt('Rename player:', set.name); if (!name || !name.trim()) return; set.name = name.trim(); window.render(true); persistState(); };
window.deleteActiveTrackSet = function deleteTrackSetForge() { if (!sets.length) return; if (sets.length === 1) { window.clearAll(); return; } sets = sets.filter(set => set.id !== activeSetId); activeSetId = sets[0] ? sets[0].id : null; selectedIds = new Set(); window.render(); persistState(); };
window.switchActiveTrackSet = function switchTrackSetForge(id) { activeSetId = id; selectedIds = new Set(); window.render(); };
window.toggleAssetPanel = function toggleAssetPanelForge() { assetPanelCollapsed = !assetPanelCollapsed; syncAssetPanelUi(); };
window.toggleBoPanel = function toggleBoPanelForge() { boPanelCollapsed = !boPanelCollapsed; syncBoPanelUi(); };
window.toggleUnitsVisibility = function toggleUnitsVisibilityForge() { showUnits = !showUnits; window.render(true); };
window.toggleCombatPanel = function toggleCombatPanelForge() { combatPanelExpanded = !combatPanelExpanded; window.render(true); };
window.toggleCombatCategory = function toggleCombatCategoryForge(category) {
  if (category === 'workers') showCombatWorkers = !showCombatWorkers;
  if (category === 'units') showCombatUnits = !showCombatUnits;
  if (category === 'buildings') showCombatBuildings = !showCombatBuildings;
  window.render(true);
};
window.copyFocusedCombatSummary = function copyFocusedCombatSummaryForge() {
  copyCombatLedger('focused');
};
window.copyAllCombatSummaries = function copyAllCombatSummariesForge() {
  copyCombatLedger('all');
};
window.buildFullAnalysisReportForCurrentDocument = function buildFullAnalysisReportForCurrentDocumentForge() {
  return buildFullAnalysisReport(sets);
};
window.getAnalysisDocumentDiagnostics = function getAnalysisDocumentDiagnosticsForge() {
  return {
    hasCopyFullAnalysisReport: typeof window.copyFullAnalysisReport === 'function',
    hasBuildFullAnalysisReportForCurrentDocument: typeof window.buildFullAnalysisReportForCurrentDocument === 'function',
    hasCombatClassificationDebug: typeof window.getCombatClassificationDebug === 'function',
    setsLength: sets.length,
    readyState: document.readyState,
  };
};
window.getCombatClassificationDebug = function getCombatClassificationDebugForge(name = null) {
  const targetSets = name
    ? sets.filter(set => set && set.name === name)
    : sets;
  return targetSets.map(set => combatClassificationDebugForSet(set));
};
window.copyFullAnalysisReport = function copyFullAnalysisReportForge() {
  copyFullAnalysisReport();
};
window.copyPromptAndAnalysisReport = function copyPromptAndAnalysisReportForge() {
  copyPromptAndAnalysisReport();
};
window.downloadEmbeddedReplay = function downloadEmbeddedReplayForge() {
  if (!embeddedReplayUrl) return;
  const link = document.createElement('a');
  link.href = embeddedReplayUrl;
  link.download = embeddedReplayName || 'replay.rep';
  document.body.appendChild(link);
  link.click();
  link.remove();
};
window.copyBO = function copyBOForge(btn) {
  const text = buildOrderCopyTextForSet(activeSet());
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const previous = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = previous; }, 1200);
  });
};
window.openBoImportModal = openBoImportModal;
window.closeBoImportModal = closeBoImportModal;
window.parseAndApply = function parseAndApplyForge() {
  let set = activeSet();
  if (!set) {
    const text = boText.value.trim();
    if (!text) return;
    set = createSet(`Player ${nextSetId}`, 'imported');
    sets.push(set);
    activeSetId = set.id;
  }
  applyBuildOrderText(set, boText.value);
  closeBoImportModal();
  window.render(true);
  persistState();
};
const analysisDocumentReadyPromise = loadState().finally(() => {
  syncAssetPanelUi();
  syncBoPanelUi();
  window.render();
});
window.waitForAnalysisDocumentReady = function waitForAnalysisDocumentReadyForge() {
  return analysisDocumentReadyPromise.then(() => ({
    setsLength: sets.length,
    readyState: document.readyState,
  }));
};
})();
