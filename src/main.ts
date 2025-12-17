import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  FuzzySuggestModal,
  moment,
  normalizePath,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import { Lunar, LunarYear } from "lunar-typescript";

type LeapStrategy = "strict" | "forward" | "backward";
type OutputMode = "single" | "range";

interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

interface LunarSolarSettings {
  sourceKey: string;
  outputMode: OutputMode;
  outputKeySingle: string;
  outputDateFormat: string;
  outputKeyPattern: string;
  rangePast: number;
  rangeFuture: number;
  defaultLeapStrategy: LeapStrategy;
  leapStrategyKey: string;
  targets: string[];
}

const DEFAULT_SETTINGS: LunarSolarSettings = {
  sourceKey: "lunar-birthday",
  outputMode: "single",
  outputKeySingle: "birthday",
  outputDateFormat: "YYYY-MM-DD",
  outputKeyPattern: "[birthday]-YYYY",
  rangePast: 1,
  rangeFuture: 1,
  defaultLeapStrategy: "forward",
  leapStrategyKey: "闰月处理模式",
  targets: [],
};

const LEAP_STRATEGY_LABEL: Record<LeapStrategy, string> = {
  strict: "严格闰月",
  forward: "向前折算",
  backward: "向后折算",
};

const LEAP_STRATEGY_LOOKUP: Record<string, LeapStrategy> = {
  "严格闰月": "strict",
  "向前折算": "forward",
  "向后折算": "backward",
  strict: "strict",
  forward: "forward",
  backward: "backward",
};

const LUNAR_INPUT_RE =
  /^(?:农历)?\s*(\d{4})-(闰)?(\d{2})-(\d{2})\s*$/;

export default class LunarSolarSyncPlugin extends Plugin {
  settings: LunarSolarSettings = DEFAULT_SETTINGS;

  async onload() {
    moment.locale("zh-cn");
    await this.loadSettings();

    this.addCommand({
      id: "lunar-solar-sync-current",
      name: "将当前笔记的农历属性转换为公历",
      callback: () => this.runOnActiveFile(),
    });

    this.addCommand({
      id: "lunar-solar-sync-all",
      name: "将所有笔记的农历属性转换为公历",
      callback: () => this.runOnAll(),
    });

    this.addSettingTab(new LunarSolarSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private getMarkdownFiles(): TFile[] {
    const targets = (this.settings.targets || []).map((t) =>
      normalizePath(t.trim())
    ).filter(Boolean);
    const markdownFiles = this.app.vault.getMarkdownFiles();
    if (targets.length === 0) return markdownFiles;
    return markdownFiles.filter((file) => {
      return targets.some((target) => {
        if (file.path === target) return true;
        const folderPrefix = target.endsWith("/") ? target : `${target}/`;
        return file.path.startsWith(folderPrefix);
      });
    });
  }

  async runOnActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("未找到当前笔记。");
      return;
    }
    const result = await processFile(
      this.app,
      file,
      this.settings
    );
    reportResult([result]);
  }

  async runOnAll() {
    const files = this.getMarkdownFiles();
    const results = [];
    for (const file of files) {
      results.push(await processFile(this.app, file, this.settings));
    }
    reportResult(results);
  }
}

class LunarSolarSettingTab extends PluginSettingTab {
  plugin: LunarSolarSyncPlugin;

  constructor(app: App, plugin: LunarSolarSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "农历→公历同步" });
    containerEl.createEl("p", {
      text: "输入格式固定为“农历YYYY-闰MM-DD”或“农历YYYY-MM-DD”（例如：农历2023-闰02-10）。",
    });

    new Setting(containerEl)
      .setName("输入键名")
      .setDesc("front matter 中存放农历日期的键名。")
      .addText((text) =>
        text
          .setPlaceholder("lunar-birthday")
          .setValue(this.plugin.settings.sourceKey)
          .onChange(async (value) => {
            this.plugin.settings.sourceKey = value.trim() || "lunar-birthday";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("输出模式")
      .setDesc("单一年份模式写入下一个最近的公历日期；多年份模式生成当前年份为中心的范围。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("single", "单一年份模式")
          .addOption("range", "多年份模式")
          .setValue(this.plugin.settings.outputMode)
          .onChange(async (value) => {
            this.plugin.settings.outputMode =
              (value as OutputMode) || "single";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.outputMode === "single") {
      new Setting(containerEl)
        .setName("输出键名")
        .setDesc("写入公历日期的键名。")
        .addText((text) =>
          text
            .setPlaceholder("birthday")
            .setValue(this.plugin.settings.outputKeySingle)
            .onChange(async (value) => {
              this.plugin.settings.outputKeySingle =
                value.trim() || "birthday";
              await this.plugin.saveSettings();
            })
        );
    } else {
      new Setting(containerEl)
        .setName("输出键名模板")
        .setDesc(
          createFragment((el) => {
            el.append(
              "支持 moment.js 格式的变量，纯文本请使用 [] 转义，例如 [birthday]-YYYY会被换为birthday-2025。 "
            );
            el.createEl("a", {
              href: "https://momentjs.com/docs/#/displaying/format/",
              text: "更多语法，请参阅",
            });
            el.createEl("div", {
              text: `当前示例：${formatSampleKey(
                this.plugin.settings.outputKeyPattern
              )}`,
              attr: { style: "color: var(--text-accent);" },
            });
          })
        )
        .addText((text) =>
          text
            .setPlaceholder("[birthday]-YYYY")
            .setValue(this.plugin.settings.outputKeyPattern)
            .onChange(async (value) => {
              this.plugin.settings.outputKeyPattern =
                value.trim() || "[birthday]-YYYY";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("年份范围")
        .setDesc("以当前年份为中心，生成前/后若干年的公历日期。")
        .addText((text) =>
          text
            .setPlaceholder("1")
            .setValue(String(this.plugin.settings.rangePast))
            .onChange(async (value) => {
              const n = Number(value);
              this.plugin.settings.rangePast = Number.isFinite(n)
                ? Math.max(0, Math.floor(n))
                : 0;
              await this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder("1")
            .setValue(String(this.plugin.settings.rangeFuture))
            .onChange(async (value) => {
              const n = Number(value);
              this.plugin.settings.rangeFuture = Number.isFinite(n)
                ? Math.max(0, Math.floor(n))
                : 0;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("输出日期格式")
      .setDesc(
        createFragment((el) => {
          el.append("支持 moment.js 格式的变量，纯文本请使用 [] 转义，例如 YYYY-MM-dd 会被转换为 2025-12-17。 ");
          el.createEl("a", {
            href: "https://momentjs.com/docs/#/displaying/format/",
            text: "更多语法，请参阅",
          });
          el.createEl("div", {
            text: `当前示例：${formatSampleDate(
              this.plugin.settings.outputDateFormat
            )}`,
            attr: { style: "color: var(--text-accent);" },
          });
        })
      )
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.outputDateFormat)
          .onChange(async (value) => {
            this.plugin.settings.outputDateFormat =
              value.trim() || "YYYY-MM-DD";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认闰月处理")
      .setDesc("严格闰月：仅目标年有对应闰月时转换；向前折算：按同月处理；向后折算：按下一个月处理。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("strict", LEAP_STRATEGY_LABEL.strict)
          .addOption("forward", LEAP_STRATEGY_LABEL.forward)
          .addOption("backward", LEAP_STRATEGY_LABEL.backward)
          .setValue(this.plugin.settings.defaultLeapStrategy)
          .onChange(async (value) => {
            this.plugin.settings.defaultLeapStrategy =
              (value as LeapStrategy) || "forward";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("笔记内闰月处理键名")
      .setDesc("笔记 front matter 中可用此键覆盖闰月处理策略（值：严格闰月/向前折算/向后折算）。")
      .addText((text) =>
        text
          .setPlaceholder("闰月处理模式")
          .setValue(this.plugin.settings.leapStrategyKey)
          .onChange(async (value) => {
            this.plugin.settings.leapStrategyKey =
              value.trim() || "闰月处理模式";
            await this.plugin.saveSettings();
          })
      );

    this.renderTargets(containerEl);

    new Setting(containerEl)
      .setName("立即对全部笔记执行")
      .addButton((button) =>
        button
          .setButtonText("运行")
          .setCta()
      .onClick(async () => {
        new Notice("开始转换所有笔记…");
        await (this.plugin as LunarSolarSyncPlugin).runOnAll();
      })
      );
  }

  private renderTargets(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "目标（可多选）" });
    containerEl.createEl("div", {
      text: "可添加多个文件或目录，执行“全部”命令时仅遍历这些路径；列表为空则处理全库。",
    });

    const wrapper = containerEl.createDiv();
    wrapper.setAttr(
      "style",
      "margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--background-modifier-border);"
    );

    const listEl = wrapper.createDiv();
    const renderList = () => {
      listEl.empty();
      this.plugin.settings.targets.forEach((path, idx) => {
        new Setting(listEl)
          .setName(`目标 ${idx + 1}`)
          .setDesc(path || "（空路径）")
          .addExtraButton((btn) =>
            btn
              .setIcon("folder")
              .setTooltip("更改为其他文件/目录")
              .onClick(() => {
                new PathSuggestModal(this.app, (value) => {
                  this.plugin.settings.targets[idx] = value;
                  this.plugin.saveSettings();
                  renderList();
                }).open();
              })
          )
          .addExtraButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("删除")
              .onClick(async () => {
                this.plugin.settings.targets.splice(idx, 1);
                await this.plugin.saveSettings();
                renderList();
              })
          );
      });
    };
    renderList();

    new Setting(wrapper)
      .setName("添加目标")
      .setDesc("从现有文件/目录中选择，追加到列表。")
      .addButton((btn) =>
        btn
          .setButtonText("选择并添加")
          .setCta()
          .onClick(() => {
            new PathSuggestModal(this.app, async (value) => {
              this.plugin.settings.targets.push(value);
              await this.plugin.saveSettings();
              renderList();
            }).open();
          })
      );
  }
}

interface ProcessResult {
  file: TFile;
  status: "updated" | "unchanged" | "skipped" | "failed";
  reason?: string;
}

function reportResult(results: ProcessResult[]) {
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  results.forEach((r) => {
    if (r.status === "updated") updated += 1;
    else if (r.status === "unchanged") unchanged += 1;
    else if (r.status === "skipped") skipped += 1;
    else failed += 1;
  });
  new Notice(
    `农历→公历：已更新 ${updated}，未变更 ${unchanged}，跳过 ${skipped}，失败 ${failed}。`
  );
  console.debug("农历→公历转换结果", results);
}

function parseLunar(raw: string): LunarDate | null {
  const m = raw.match(LUNAR_INPUT_RE);
  if (!m) return null;
  const [, yearStr, leap, monthStr, dayStr] = m;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    isLeap: !!leap,
  };
}

function parseLeapStrategy(value: unknown, fallback: LeapStrategy): LeapStrategy {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const mapped = LEAP_STRATEGY_LOOKUP[trimmed];
    if (mapped) return mapped;
  }
  return fallback;
}

function yearHasLeapMonth(year: number, month: number): boolean {
  try {
    const leapMonth = LunarYear.fromYear(year).getLeapMonth();
    return leapMonth === month;
  } catch (e) {
    console.warn("检测闰月信息失败", e);
    return false;
  }
}

function resolveLunarMonth(
  year: number,
  lunar: LunarDate,
  strategy: LeapStrategy
): { month: number; isLeap: boolean } | null {
  if (!lunar.isLeap) {
    return { month: lunar.month, isLeap: false };
  }

  const hasLeap = yearHasLeapMonth(year, lunar.month);

  if (strategy === "strict") {
    if (!hasLeap) return null;
    return { month: lunar.month, isLeap: true };
  }

  if (strategy === "forward") {
    if (hasLeap) return { month: lunar.month, isLeap: true };
    return { month: lunar.month, isLeap: false };
  }

  if (strategy === "backward") {
    if (hasLeap) return { month: lunar.month, isLeap: true };
    const nextMonth = lunar.month === 12 ? 12 : lunar.month + 1;
    return { month: nextMonth, isLeap: false };
  }

  return null;
}

function toSolar(
  year: number,
  lunar: LunarDate,
  strategy: LeapStrategy
): moment.Moment | null {
  const resolved = resolveLunarMonth(year, lunar, strategy);
  if (!resolved) return null;
  try {
    const lunarMonth = resolved.isLeap ? -resolved.month : resolved.month;
    const l = (Lunar as any).fromYmd(year, lunarMonth, lunar.day);
    const solar = l.getSolar();
    const date = new Date(
      solar.getYear(),
      solar.getMonth() - 1,
      solar.getDay()
    );
    return moment(date);
  } catch (e) {
    console.warn("农历转换失败", { year, lunar, strategy, error: e });
    return null;
  }
}

function findNextSolar(
  lunar: LunarDate,
  strategy: LeapStrategy
): moment.Moment | null {
  const today = moment().startOf("day");
  const MAX_SEARCH_YEARS = 80; // 足够覆盖多个闰月周期
  for (let i = 0; i < MAX_SEARCH_YEARS; i++) {
    const targetYear = today.year() + i;
    const solar = toSolar(targetYear, lunar, strategy);
    if (solar && solar.isSameOrAfter(today, "day")) {
      return solar;
    }
  }
  return null;
}

function buildRangeOutputs(
  lunar: LunarDate,
  strategy: LeapStrategy,
  settings: LunarSolarSettings,
  centerYear: number
): Record<string, string> {
  const result: Record<string, string> = {};
  const keyPattern = escapeLiteralForMoment(settings.outputKeyPattern);
  for (
    let y = centerYear - settings.rangePast;
    y <= centerYear + settings.rangeFuture;
    y++
  ) {
    const solar = toSolar(y, lunar, strategy);
    if (!solar) continue;
    const key = solar.format(keyPattern);
    result[key] = solar.format(settings.outputDateFormat);
  }
  return result;
}

/**
 * 将 moment 模式串中的非格式部分包裹在 [] 中，避免被误解析。
 * 保留已有的 [] 与已知格式 token，其余连续文本视为纯文本。
 */
function escapeLiteralForMoment(pattern: string): string {
  const tokenRe =
    /\[.*?]|YYYY|YY|QO?|MMMM|MMM|MM|M|DDDD|DDD|DD|D|Do|dddd|ddd|dd|d|WWWW|WWW|WW|W|HH?|hh?|mm?|ss?|A|a|X|x|Z{1,2}|SSS|SS|S/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(pattern)) !== null) {
    if (m.index > lastIndex) {
      const literal = pattern.slice(lastIndex, m.index);
      parts.push(wrapLiteral(literal));
    }
    parts.push(m[0]);
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < pattern.length) {
    parts.push(wrapLiteral(pattern.slice(lastIndex)));
  }
  return parts.join("");
}

function wrapLiteral(text: string): string {
  if (!text) return "";
  return `[${text.replace(/]/g, "\\]")}]`;
}

function formatSampleKey(pattern: string): string {
  const safePattern = pattern?.trim() || "[birthday]-YYYY";
  const fmt = escapeLiteralForMoment(safePattern);
  try {
    return moment().format(fmt);
  } catch (e) {
    console.warn("输出键名模板预览失败", e);
    return "格式错误";
  }
}

function formatSampleDate(format: string): string {
  const fmt = format?.trim() || "YYYY-MM-DD";
  try {
    return moment().format(fmt);
  } catch (e) {
    console.warn("输出日期格式预览失败", e);
    return "格式错误";
  }
}

async function processFile(
  app: App,
  file: TFile,
  settings: LunarSolarSettings
): Promise<ProcessResult> {
  try {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter) {
      return { file, status: "skipped", reason: "no-frontmatter" };
    }

    const frontmatter = cache.frontmatter;
    const raw = frontmatter[settings.sourceKey];
    if (typeof raw !== "string") {
      return { file, status: "skipped", reason: "no-source-key" };
    }

    const lunar = parseLunar(raw);
    if (!lunar) {
      return { file, status: "skipped", reason: "invalid-format" };
    }

    const leapStrategy = parseLeapStrategy(
      frontmatter[settings.leapStrategyKey],
      settings.defaultLeapStrategy
    );

    let updates: Record<string, string> = {};

    if (settings.outputMode === "single") {
      const solar = findNextSolar(lunar, leapStrategy);
      if (!solar) {
        return { file, status: "skipped", reason: "no-solar" };
      }
      updates[settings.outputKeySingle] = solar.format(
        settings.outputDateFormat
      );
    } else {
      updates = buildRangeOutputs(
        lunar,
        leapStrategy,
        settings,
        moment().year()
      );
      if (Object.keys(updates).length === 0) {
        return { file, status: "skipped", reason: "no-solar" };
      }
    }

    const changed = await writeFrontmatter(app, file, updates);
    return { file, status: changed ? "updated" : "unchanged" };
  } catch (e) {
    console.error("处理文件出错", file.path, e);
    return { file, status: "failed", reason: "exception" };
  }
}

async function writeFrontmatter(
  app: App,
  file: TFile,
  updates: Record<string, string>
): Promise<boolean> {
  const content = await app.vault.read(file);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  let body = content;
  let data: Record<string, any> = {};

  if (match) {
    data = parseYaml(match[1]) || {};
    body = content.slice(match[0].length);
  }

  let changed = false;
  Object.entries(updates).forEach(([key, value]) => {
    if (data[key] !== value) {
      data[key] = value;
      changed = true;
    }
  });

  if (!changed) return false;

  const yaml = stringifyYaml(data).trimEnd();
  const newContent = `---\n${yaml}\n---\n${body}`;
  await app.vault.modify(file, newContent);
  return true;
}
class PathSuggestModal extends FuzzySuggestModal<string> {
  private onChoose: (value: string) => void;

  constructor(app: App, onChoose: (value: string) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("选择文件或目录");
  }

  getItems(): string[] {
    const items: string[] = [];
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if (f instanceof TFile || f instanceof TFolder) {
        items.push(f.path);
      }
    });
    return items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}
