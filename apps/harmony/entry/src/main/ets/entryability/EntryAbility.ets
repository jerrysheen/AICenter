import { AbilityConstant, Configuration, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0xA1C0;
const TAG = 'AI_CENTER_SHELL';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate<string>('launchUri', want.uri ?? '');
    AppStorage.setOrCreate<number>('localInspirationRefreshVersion', 0);
    hilog.info(DOMAIN, TAG, 'AI Center shell created');
  }

  onForeground(): void {
    const version = AppStorage.get<number>('localInspirationRefreshVersion') ?? 0;
    AppStorage.set<number>('localInspirationRefreshVersion', version + 1);
  }

  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate<string>('launchUri', want.uri ?? '');
    AppStorage.set<string>('launchUri', want.uri ?? '');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load Index: %{public}s', JSON.stringify(error));
        return;
      }
      hilog.info(DOMAIN, TAG, 'Index loaded');
    });
  }

  onConfigurationUpdate(_configuration: Configuration): void {
    hilog.info(DOMAIN, TAG, 'Configuration updated');
  }
}
