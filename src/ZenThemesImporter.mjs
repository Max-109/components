const kZenStylesheetThemeHeader = `
/* Zen Themes - Generated by ZenThemeImporter.
  * DO NOT EDIT THIS FILE DIRECTLY!
  * Your changes will be overwritten.
  * Instead, go to the preferences and edit the themes there.
  */
`;
const kenStylesheetFooter = `
/* End of Zen Themes */
`;

const kZenOSToSmallName = {
  WINNT: 'windows',
  Darwin: 'macos',
  Linux: 'linux',
};

var gZenStylesheetManager = {
  async writeStylesheet(path, themes) {
    let content = kZenStylesheetThemeHeader;
    for (let theme of themes) {
      if (!theme.enabled) {
        continue;
      }
      content += this.getThemeCSS(theme);
    }
    content += kenStylesheetFooter;
    let buffer = new TextEncoder().encode(content);
    await IOUtils.write(path, buffer);
  },

  getThemeCSS(theme) {
    let css = '\n';
    if (theme._readmeURL) {
      css += `/* Name: ${theme.name} */\n`;
      css += `/* Description: ${theme.description} */\n`;
      css += `/* Author: @${theme.author} */\n`;
      css += `/* Readme: ${theme.readme} */\n`;
    }
    css += `@import url("${theme._chromeURL}");\n`;
    return css;
  },
};

var gZenThemeImporter = new (class {
  constructor() {
    console.info('ZenThemeImporter: Initiating Zen theme importer');
    try {
      window.SessionStore.promiseInitialized.then(async () => {
        this.insertStylesheet();

        const themesWithPreferences = await Promise.all(
          Object.values(await this.getThemes()).map(async (theme) => {
            const preferences = await this._getThemePreferences(theme);

            return {
              name: theme.name,
              enabled: theme.enabled,
              preferences,
            };
          })
        );

        this.writeToDom(themesWithPreferences);
      });
      console.info('ZenThemeImporter: Zen theme imported');
    } catch (e) {
      console.error('ZenThemeImporter: Error importing Zen theme: ', e);
    }
    Services.prefs.addObserver('zen.themes.updated-value-observer', this.rebuildThemeStylesheet.bind(this), false);
  }

  get sss() {
    if (!this._sss) {
      this._sss = Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService);
    }
    return this._sss;
  }

  get styleSheetPath() {
    return PathUtils.join(PathUtils.profileDir, 'chrome', 'zen-themes.css');
  }

  get themesRootPath() {
    return PathUtils.join(PathUtils.profileDir, 'chrome', 'zen-themes');
  }

  get themesDataFile() {
    return PathUtils.join(PathUtils.profileDir, 'zen-themes.json');
  }

  getThemeFolder(theme) {
    return PathUtils.join(this.themesRootPath, theme.id);
  }

  async getThemes() {
    if (!this._themes) {
      if (!(await IOUtils.exists(this.themesDataFile))) {
        await IOUtils.writeJSON(this.themesDataFile, {});
      }

      this._themes = await IOUtils.readJSON(this.themesDataFile);
    }
    return this._themes;
  }

  async rebuildThemeStylesheet() {
    this._themes = null;
    await this.updateStylesheet();
  }

  get styleSheetURI() {
    if (!this._styleSheetURI) {
      this._styleSheetURI = Services.io.newFileURI(new FileUtils.File(this.styleSheetPath));
    }
    return this._styleSheetURI;
  }

  getStylesheetURIForTheme(theme) {
    return Services.io.newFileURI(new FileUtils.File(PathUtils.join(this.getThemeFolder(theme), 'chrome.css')));
  }

  async insertStylesheet() {
    if (await IOUtils.exists(this.styleSheetPath)) {
      await this.sss.loadAndRegisterSheet(this.styleSheetURI, this.sss.AGENT_SHEET);
    }
  }

  async removeStylesheet() {
    await this.sss.unregisterSheet(this.styleSheetURI, this.sss.AGENT_SHEET);
  }

  async updateStylesheet() {
    await this.removeStylesheet();

    const themes = Object.values(await this.getThemes());
    await this.writeStylesheet(themes);

    const themesWithPreferences = await Promise.all(
      themes.map(async (theme) => {
        const preferences = await this._getThemePreferences(theme);

        return {
          name: theme.name,
          enabled: theme.enabled,
          preferences,
        };
      })
    );

    this.setDefaults(themesWithPreferences);
    this.writeToDom(themesWithPreferences);

    await this.insertStylesheet();
  }

  _getBrowser() {
    if (!this.__browser) {
      this.__browser = Services.wm.getMostRecentWindow('navigator:browser');
    }

    return this.__browser;
  }

  get currentOperatingSystem() {
    let os = Services.appinfo.OS;
    return kZenOSToSmallName[os];
  }

  async _getThemePreferences(theme) {
    const themePath = PathUtils.join(this.getThemeFolder(theme), 'preferences.json');

    if (!(await IOUtils.exists(themePath)) || !theme.preferences) {
      return [];
    }

    const preferences = await IOUtils.readJSON(themePath);

    if (typeof preferences === 'object' && !Array.isArray(preferences)) {
      console.warn(
        `[ZenThemesImporter]: Warning, ${theme.name} uses legacy preferences, please migrate them to the new preferences style, as legacy preferences might be removed at a future release. More information at: https://docs.zen-browser.app/themes-store/themes-marketplace-preferences`
      );
      const newThemePreferences = [];

      for (let [entry, label] of Object.entries(preferences)) {
        const [_, negation = '', os = '', property] = /(!?)(?:(macos|windows|linux):)?([A-z0-9-_.]+)/g.exec(entry);
        const isNegation = negation === '!';

        if (
          (isNegation && os === this.currentOperatingSystem) ||
          (os !== '' && os !== this.currentOperatingSystem && !isNegation)
        ) {
          continue;
        }

        newThemePreferences.push({
          property,
          label,
          type: 'checkbox',
          disabledOn: os !== '' ? [os] : [],
        });
      }

      return newThemePreferences;
    }

    return preferences.filter(({ disabledOn = [] }) => !disabledOn.includes(this.currentOperatingSystem));
  }

  setDefaults(themesWithPreferences) {
    for (const { preferences } of themesWithPreferences) {
      for (const { type, property, defaultValue } of preferences) {
        if (defaultValue === undefined) {
          continue;
        }

        switch (type) {
          case 'checkbox': {
            const value = Services.prefs.getBoolPref(property, false);
            if (typeof defaultValue !== 'boolean') {
              console.log(`[ZenThemesImporter]: Warning, invalid data type received for expected type boolean, skipping.`);
              continue;
            }

            if (!value) {
              Services.prefs.setBoolPref(property, defaultValue);
            }
            break;
          }

          default: {
            const value = Services.prefs.getStringPref(property, 'zen-property-no-saved');

            if (typeof defaultValue !== 'string' && typeof defaultValue !== 'number') {
              console.log(`[ZenThemesImporter]: Warning, invalid data type received (${typeof defaultValue}), skipping.`);
              continue;
            }

            if (value === 'zen-property-no-saved') {
              Services.prefs.setStringPref(property, defaultValue.toString());
            }
          }
        }
      }
    }
  }

  writeToDom(themesWithPreferences) {
    const browser = this._getBrowser();

    for (const { enabled, preferences, name } of themesWithPreferences) {
      const sanitizedName = `theme-${name?.replaceAll(/\s/g, '-')?.replaceAll(/[^A-z_-]+/g, '')}`;

      if (!enabled) {
        const element = browser.document.getElementById(sanitizedName);

        if (element) {
          element.remove();
        }

        for (const { property } of preferences.filter(({ type }) => type !== 'checkbox')) {
          const sanitizedProperty = property?.replaceAll(/\./g, '-');

          if (document.querySelector(':root').style.hasProperty(`--${sanitizedProperty}`)) {
            document.querySelector(':root').style.removeProperty(`--${sanitizedProperty}`);
          }
        }

        continue;
      }

      for (const { property, type } of preferences) {
        const value = Services.prefs.getStringPref(property, '');
        const sanitizedProperty = property?.replaceAll(/\./g, '-');

        switch (type) {
          case 'dropdown': {
            if (value !== '') {
              let element = browser.document.getElementById(sanitizedName);

              if (!element) {
                element = browser.document.createElement('div');

                element.style.display = 'none';
                element.setAttribute('id', sanitizedName);

                browser.document.body.appendChild(element);
              }

              element.setAttribute(sanitizedProperty, value);
            }
            break;
          }

          case 'string': {
            if (value === '') {
              document.querySelector(':root').style.removeProperty(`--${sanitizedProperty}`);
            } else {
              document.querySelector(':root').style.setProperty(`--${sanitizedProperty}`, value);
            }
            break;
          }

          default: {
          }
        }
      }
    }
  }

  async writeStylesheet(themeList) {
    const themes = [];
    this._themes = null;

    for (let theme of themeList) {
      theme._chromeURL = this.getStylesheetURIForTheme(theme).spec;
      themes.push(theme);
    }

    await gZenStylesheetManager.writeStylesheet(this.styleSheetPath, themes);
  }
})();
