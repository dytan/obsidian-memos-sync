import type { Authorization, Note } from "kirika";
import {
  getAttachmentContent,
  getNoteContent,
  readMemosFromOpenAPI,
} from "kirika";
import type { App } from "obsidian";
import {
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile
} from "obsidian";
import { getAllDailyNotes, createDailyNote, getDailyNote } from 'obsidian-daily-notes-interface';
import moment from 'moment';



/**
 * Possible sync intervals in minutes.
 */
type Interval = 120 | 60 | 30 | 15 | 5 | 0;

/**
 * Formats for file names of synced memos.
 */
type FileNameFormat = "id" | "created_at" | "updated_at" | "title";

/**
 * Settings for the Memos Sync plugin.
 */
type MemosSyncPluginSettings = {
  auth: Authorization;
  folderToSync: string;
  fileNameFormat: FileNameFormat;
  interval: Interval;
  lastSyncTime?: number;
};

const DEFAULT_SETTINGS: MemosSyncPluginSettings = {
  auth: {
    baseUrl: "",
  },
  folderToSync: "Memos Sync",
  fileNameFormat: "id",
  interval: 0,
};

export default class MemosSyncPlugin extends Plugin {
  settings: MemosSyncPluginSettings;
  timer: number | null = null;

  async registerSyncInterval() {
    await this.loadSettings();
    const { interval } = this.settings;
    if (this.timer) {
      window.clearInterval(this.timer);
    }
    if (interval > 0) {
      this.timer = this.registerInterval(
        window.setInterval(this.sync.bind(this), interval * 60 * 1000),
      );
    }
  }

  async onload() {
    await this.registerSyncInterval();
    this.addRibbonIcon("refresh-ccw", "Memos Sync", this.sync.bind(this));
    this.addSettingTab(new MemosSyncSettingTab(this.app, this));
  }

  onunload() { }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async sync() {
    await this.loadSettings();
    const { auth, folderToSync, lastSyncTime } = this.settings;

    // counters for the sync result
    let sameCount = 0;
    let updatedCount = 0;
    let newCount = 0;

    if (!auth.baseUrl) {
      new Notice("Please enter the base URL.")
      return
    }

    if (!auth.accessToken && !auth.openId) {
      new Notice("Please enter the access token or open ID.")
      return
    }

    try {
      new Notice("Started syncing memos...")

      const res = await readMemosFromOpenAPI(auth)
      const memos = res.notes.filter((i) => !i.metadata.isArchived)

      const vault = this.app.vault

      // check if daily notes plugin is loaded

      const allDailyNotes = getAllDailyNotes();

      memos.forEach((memo) => {
        const memoContent = getNoteContent(memo);
        const created = memo.metadata.createdAt;
        const updated = memo.metadata.updatedAt;

        const dailyNote = getDailyNote(moment(created), allDailyNotes);
        // const memosOnDaily = getMemosOnDailyNote(dailyNote);
        if (dailyNote) {
          // memoContent add to dailyNote
          // check if memoContent is already in dailyNote
          // memo Resource add to dailyNote
          const formattedTime = moment(created).format("hh:mm");
          // console.log(memoContent);
          // <br> 太多了
          const formattedContent = memoContent.replace(/\n(?!\s*$)/g, '<br>');
          // console.log(formattedContent);
          const memosOnDaily: Map<string, string> = new Map<string, string>();

          // const memosOnDaily: { timestamp: string; content: string; }[] = [];
          vault.read(dailyNote).then((content) => {
            // console.log(content);
            const regex = /- (\d{1,2}:\d{2}) ((?:.|\n)+?)(?=\n- \d{1,2}:\d{2} |\n*$)/g;

            let match;

            while ((match = regex.exec(content)) !== null) {
              const timestamp = match[1];
              const content = match[2].trim();
              memosOnDaily.set(timestamp, content);
            }

            // console.log(memosOnDaily);
            // console.log(memosOnDaily.length);
            // memosOnDaily is a set and formattedTime if in memosOnDaily
            console.log(memosOnDaily);
            if (memosOnDaily.has(formattedTime)) {
              console.log("same memo", memosOnDaily.get(formattedTime), formattedContent);
              console.log(created, updated);
              if (updated !== created) {
                // update dailynote's memo
                console.log("memo update", memosOnDaily.get(formattedTime), formattedContent);
                const updatedContent = content.replace(memosOnDaily.get(formattedTime)!, formattedContent);
                vault.modify(dailyNote, updatedContent);
                return;
              }
              return;
            } else {
              // insert dailynote
              console.log("new memo", formattedTime, formattedContent);
              vault.append(dailyNote, `- ${formattedTime} ${formattedContent}\n`);
            }

            // memosOnDaily.forEach((memo) => {
            //   if (memo.timestamp === formattedTime && memo.content === formattedContent) {
            //     console.log("same memo", memo.content, formattedContent);
            //     return;
            //   } else if (memo.timestamp === formattedTime && memo.content !== formattedContent) {
            //     // update dailynote's memo
            //     console.log("memo update", memo.content, formattedContent);
            //     const updatedContent = content.replace(memo.content, formattedContent);
            //     vault.modify(dailyNote, updatedContent);
            //     return;
            //   } else {
            //     // insert dailynote
            //     console.log("new memo", formattedContent);
            //     vault.append(dailyNote, `- ${formattedTime} ${formattedContent}\n`);
            //   }


            // }
            // );
            // console.log(memosOnDaily);
          });
        } else {
          createDailyNote(moment(created)).then((dailyNote) => {
            // memoContent add to dailyNote
            // memo Resource add to dailyNote
            const formattedTime = moment(created).format("hh:mm");
            const formattedContent = memoContent.replace(/\n(?!\s*$)/g, '<br>');
            console.log(memoContent);
            console.log(formattedContent);

            vault.append(dailyNote, `- ${formattedTime} ${formattedContent}\n`);
          });
        }





      })



      new Notice("Successfully synced memos.")

      new Notice(`Successfully synced memos. Total: ${memos.length}, Same: ${sameCount}, Updated: ${updatedCount}, New: ${newCount}.`);

      this.saveData({
        ...this.settings,
        lastSyncTime: Date.now(),
      }).catch((e) => {
        console.error(e)
      })
    } catch (e) {
      new Notice(
        "Failed to sync memos. Please check your authorization settings and network connection.",
        0,
      )
      console.error(e)
    }
  }
}

class MemosSyncSettingTab extends PluginSettingTab {
  plugin: MemosSyncPlugin;

  constructor(app: App, plugin: MemosSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Memos Sync Settings" });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        "* The host of your memos server.(e.g. https://demo.usememos.com)",
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter your Base URL")
          .setValue(this.plugin.settings.auth.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.auth.baseUrl = value
            await this.plugin.saveSettings()
          }),
      );

    new Setting(containerEl)
      .setName("Access Token")
      .setDesc("Set this if your memos version is over 0.15.0.")
      .addText((text) =>
        text
          .setPlaceholder("Enter your access token")
          .setValue(this.plugin.settings.auth.accessToken || "")
          .onChange(async (value) => {
            this.plugin.settings.auth.accessToken = value
            await this.plugin.saveSettings()
          }),
      );

    new Setting(containerEl)
      .setName("Open ID")
      .setDesc("Set this if your memos version is under 0.15.0.")
      .addText((text) =>
        text
          .setPlaceholder("Enter your open ID")
          .setValue(this.plugin.settings.auth.openId || "")
          .onChange(async (value) => {
            this.plugin.settings.auth.openId = ""
            await this.plugin.saveSettings()
          }),
      );

    new Setting(containerEl)
      .setName("Folder to sync")
      .setDesc("The folder to sync memos and resources.")
      .addText((text) =>
        text
          .setPlaceholder("Enter the folder name")
          .setValue(this.plugin.settings.folderToSync)
          .onChange(async (value) => {
            if (value === "") {
              new Notice("Please enter the folder name.")
              return
            }
            this.plugin.settings.folderToSync = value
            await this.plugin.saveSettings()
          }),
      );

    new Setting(containerEl)
      .setName("File name format")
      .setDesc("The format of the file name for memos.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("id", "ID")
          .addOption("created_at", "Created at")
          .addOption("updated_at", "Updated at")
          .addOption("title", "Title")
          .setValue(this.plugin.settings.fileNameFormat)
          .onChange(async (value) => {
            this.plugin.settings.fileNameFormat = value as FileNameFormat
            await this.plugin.saveSettings()
          }),
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("The interval to sync memos.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("0", "Close")
          .addOption("5", "Every 5 minutes")
          .addOption("15", "Every 15 minutes")
          .addOption("30", "Every 30 minutes")
          .addOption("60", "Every 1 hour")
          .addOption("120", "Every 2 hours")
          .setValue(String(this.plugin.settings.interval))
          .onChange(async (value) => {
            this.plugin.settings.interval = Number(value) as Interval
            await this.plugin.saveSettings()
            await this.plugin.registerSyncInterval()
          }),
      );
  }
}
