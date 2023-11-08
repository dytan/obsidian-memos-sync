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
import { text } from "stream/consumers";



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

  dailyNotePath: string;
  saveToDailyNote: boolean;
  insertAfter: string;

  lastSyncTime?: number;
};

const DEFAULT_SETTINGS: MemosSyncPluginSettings = {
  auth: {
    baseUrl: "",
  },
  folderToSync: "Memos Sync",
  fileNameFormat: "id",
  
  interval: 0,
  saveToDailyNote: true,
  dailyNotePath: "Journal",
  insertAfter: "# 📝 Notes"
};



// escape regular expression special characters
function escapeRegExp(text: any){
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// split content string to lines 
function getLinesInString(input: string){
  const lines: string[] = [];
  let tempString = input;

  while (tempString.contains('\n')){
    const lineEndIndex = tempString.indexOf('\n');
    lines.push(tempString.slice(0, lineEndIndex));
    tempString = tempString.slice(lineEndIndex + 1);
  }

  lines.push(tempString);

  return lines;
}

// insert text after position in body
function insertTextAfterPositionInBody(
  text: string,
  body: string,
  pos: number,
  found?: boolean,
)  {
  if (pos === -1) {
    return {
      content: `${body}\n${text}`,
      posNum: -1,
    };
  }

  const splitContent = body.split('\n');

  if (found) {
    const pre = splitContent.slice(0, pos + 1).join('\n');
    const post = splitContent.slice(pos + 1).join('\n');
    // return `${pre}\n${text}\n${post}`;
    return {
      content: `${pre}\n${text}\n${post}`,
      posNum: pos,
    };
  } else {
    const pre = splitContent.slice(0, pos + 1).join('\n');
    const post = splitContent.slice(pos + 1).join('\n');
    if (/[\s\S]*?/g.test(post)) {
      return {
        content: `${pre}\n${text}`,
        posNum: pos,
      };
    } else {
      return {
        content: `${pre}${text}\n${post}`,
        posNum: pos,
      };
    }
    // return `${pre}${text}\n${post}`;
  }
}

  
// credit credit to chhoumann, original code from: https://github.com/chhoumann/quickadd
function insertAfterHandler(targetString: string, formatted: string, fileContent: string){

  // find the target position to insert after by regex search
  const targetRegex = new RegExp(`\s*${escapeRegExp(targetString)}\s*`);
  const fileContentLines: string[] = getLinesInString(fileContent);

  const targetPosition = fileContentLines.findIndex((line) => targetRegex.test(line));
  const targetNotFound = targetPosition === -1; 
  if (targetNotFound){
    console.log("unable to find insert after line in file.");
  }


  // find the next header to be the end of the section
  const nextHeaderPositionAfterTargetPosition = fileContentLines
    .slice(targetPosition + 1)
    .findIndex((line) => /^#+ |---/.test(line));
  const foundNextHeader = nextHeaderPositionAfterTargetPosition !== -1;


  if (foundNextHeader){
    let endOfSectionIndex: number = 0;

    for (let i = nextHeaderPositionAfterTargetPosition + targetPosition; i > targetPosition; i--) {
      const lineIsNewline: boolean = /^[\s\n ]*$/.test(fileContentLines[i]);
      if (!lineIsNewline) {
        endOfSectionIndex = i;
        break;
      }
    }

    if (!endOfSectionIndex){
      endOfSectionIndex = targetPosition;
    }

    return insertTextAfterPositionInBody(formatted, fileContent, endOfSectionIndex, foundNextHeader); 
  } else {
    return insertTextAfterPositionInBody(formatted, fileContent, fileContentLines.length - 1, foundNextHeader);
  }
  
}


// format date to file name format
function formatDateToFileFormat(date: Date) {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()

  return `${year}-${month}-${day}-${hours}-${minutes}`
}

// return file name based on format
function getFileName(memo: Note, format: FileNameFormat) {
  switch (format) {
    case "id":
      return memo.id
    case "created_at":
      return formatDateToFileFormat(
        memo.metadata.createdAt
          ? new Date(memo.metadata.createdAt)
          : new Date(),
      )
    case "updated_at":
      return formatDateToFileFormat(
        memo.metadata.updatedAt
          ? new Date(memo.metadata.updatedAt)
          : new Date(),
      )
    case "title":
      return memo.title
  }
}


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
    const { auth, folderToSync, lastSyncTime, saveToDailyNote, insertAfter, dailyNotePath} = this.settings;

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

      const res = await readMemosFromOpenAPI(auth);
      const memos = res.notes.filter((i) => !i.metadata.isArchived);

      const vault = this.app.vault;
      const adapter = this.app.vault.adapter;


      // resource path
      let resourceFolder = `${folderToSync}/resources`;
      if (saveToDailyNote){
        resourceFolder = `${dailyNotePath}/resources`;
      }
      if (!adapter.exists(resourceFolder)) {
        adapter.mkdir(resourceFolder);
      }



      //TODO check if daily notes plugin is loaded


      if (saveToDailyNote){
        // sync memos to daily notes

        const allDailyNotes = getAllDailyNotes();

        // group memos by daily note
        let memosByDaily: Map<TFile, Array<any>> = new Map<TFile, Array<any>>();

        for (const memo of memos){
          const created = memo.metadata.createdAt;
          let dailyNote: TFile = getDailyNote(moment(created), allDailyNotes);

          // create daily note if not exists
          // TODO, template
          if (!dailyNote){
            dailyNote = await createDailyNote(moment(created));
          }

          if (memosByDaily.has(dailyNote)){
            memosByDaily.get(dailyNote)?.push(memo);
          }
          else{
            memosByDaily.set(dailyNote, [memo]);
          }
        }


        // write memos to daily notes
        for (const [dailyNote, memos] of memosByDaily){

          vault.read(dailyNote).then((content) => {

            // get existing memos on daily note
            const memosOnDaily: Map<string, string> = new Map<string, string>();

            const regex = /- (\d{1,2}:\d{2}) ((?:.|\n)+?)(?=\n- \d{1,2}:\d{2} |\n*$)/g;
            let match;

            while ((match = regex.exec(content)) !== null) {
              const timestamp = match[1];
              const content = match[2].trim();
              memosOnDaily.set(timestamp, content);
            }


            // memosOnDaily is a set and formattedTime if in memosOnDaily
            console.log(memosOnDaily);
 
            for (const memo of memos){

              const updated = memo.metadata.updatedAt;
              const created = memo.metadata.createdAt;

              const formattedTime = moment(memo.metadata.createdAt).format("hh:mm");
              // const formattedContent = getNoteContent(memo).replace(/\n(?!\s*$)/g, '<br>');
              const formattedContent = getNoteContent(memo).replace(/\n/g, '<br>');


              if (memosOnDaily.has(formattedTime)) {
                console.log("same memo", memosOnDaily.get(formattedTime), formattedContent);

                if (updated !== created) {
                  // update daily note's memo

                  updatedCount += 1;
                  console.log("memo update", memosOnDaily.get(formattedTime), formattedContent);
                  const updatedContent = content.replace(memosOnDaily.get(formattedTime)!, formattedContent);
                  
                  content = updatedContent;
                }
                else {
                  // keep the same
                  sameCount += 1;
                }
              } else {
                // insert to daily note
                
                const newFileContent = insertAfterHandler(
                  insertAfter, 
                  `- ${formattedTime} ${formattedContent}\n`, content
                );
                content = newFileContent.content;

                newCount += 1;
              }

              vault.modify(dailyNote, content);
            }

          });

        }
      
      }
      else{
        // sync memos to folder
        memos.forEach(async (memo) => {

          const memoPath = normalizePath(
            `${folderToSync}/memos/${getFileName(
              memo, this.settings.fileNameFormat
            )}.md`,
          ); 

          const memoContent = getNoteContent(memo);
          const lastUpdated = memo.metadata.updatedAt || -1;

         
          if (await adapter.exists(memoPath)){
            const stat = await adapter.stat(memoPath) || {mtime: 0};
            if (stat.mtime > lastUpdated * 1000) {
              sameCount += 1;
              return;
            }
            else{
              updatedCount += 1;
            }
          }
          else {
            newCount += 1;
          }


          adapter.write(memoPath, memoContent).catch((e) => {
            console.error(e);
          });
        
        });
      }



      new Notice("Successfully synced memos.")
      new Notice(`Successfully synced memos. Total: ${memos.length}, Same: ${sameCount}, Updated: ${updatedCount}, New: ${newCount}.`);


      // sync resources
      let num_resource_added: number = 0;
      for (const resource of res.files){
        const resourcePath = normalizePath(`${resourceFolder}/${resource.filename}`);

        const isResourceExists = await adapter.exists(resourcePath);
        if (isResourceExists){
          continue;
        }

        // create subpath recursively
        if (resource.filename.includes('/')){
          const resourcePathSplitted = resource.filename.split('/');

          for (let i=0; i<resourcePathSplitted.length - 1; i++){
            const folderPath = normalizePath(
              `${resourceFolder}/${resourcePathSplitted.slice(0, i+1).join('/')}`,
            );

            const isFolderExists = await adapter.exists(folderPath);
            if (!isFolderExists){
              await vault.createFolder(folderPath);
            }
          }
        }

        // write resource
        const resourceContent = await getAttachmentContent(resource, auth);
        if (!resourceContent){
          continue;
        }

        adapter.writeBinary(resourcePath, resourceContent).catch((e) => {
          console.error(e);
        });
        num_resource_added += 1;

      }
      new Notice(`total ${num_resource_added} resource synced.`);


      this.saveData({
        ...this.settings,
        lastSyncTime: Date.now(),
      }).catch((e) => {
        console.error(e)
      })
    }
    catch (e) {
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
      .setName("Save to Daily Note")
      .setDesc("Save memos to daily note.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.saveToDailyNote)
          .onChange(async (value) => {
            this.plugin.settings.saveToDailyNote = value
            await this.plugin.saveSettings()
          }),
      );
    
    
    new Setting(containerEl)
      .setName("Daily Note Path")
      .setDesc("The path to daily note.")
      .addText((text) =>
        text 
          .setPlaceholder("Enter the daily note path")
          .setValue(this.plugin.settings.dailyNotePath)
          .onChange(async (value) => {
            this.plugin.settings.dailyNotePath = value
            await this.plugin.saveSettings()
          }),
      );


    new Setting(containerEl)
      .setName("Insert After Heading")
      .setDesc("The heading to insert memos after.")
      .addText((text) =>
        text 
          .setPlaceholder("Enter the heading")
          .setValue(this.plugin.settings.insertAfter)
          .onChange(async (value) => {
            this.plugin.settings.insertAfter = value
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
