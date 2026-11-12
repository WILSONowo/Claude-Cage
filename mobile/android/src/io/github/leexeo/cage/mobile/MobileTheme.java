package io.github.leexeo.cage.mobile;

import android.app.Activity;
import android.content.res.Configuration;
import android.view.View;

final class MobileTheme {
    final boolean dark;
    final int bg, panel, ink, muted, line, soft, action, onAction;

    private MobileTheme(boolean dark) {
        this.dark = dark;
        bg = dark ? 0xff151517 : 0xfffafafa;
        panel = dark ? 0xff1c1c1f : 0xffffffff;
        ink = dark ? 0xfff4f4f5 : 0xff18181b;
        muted = dark ? 0xffb3b3bd : 0xff52525b;
        line = dark ? 0xff3b3b42 : 0xffe4e4e9;
        soft = dark ? 0xff27272b : 0xfff4f4f5;
        action = ink;
        onAction = bg;
    }

    static MobileTheme apply(Activity activity, String mode) {
        int night = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = "dark".equals(mode) || (!"light".equals(mode) && night == Configuration.UI_MODE_NIGHT_YES);
        activity.setTheme(dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        MobileTheme theme = new MobileTheme(dark);
        activity.getWindow().setStatusBarColor(theme.bg);
        activity.getWindow().setNavigationBarColor(theme.bg);
        activity.getWindow().getDecorView().setSystemUiVisibility(dark ? 0 :
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        return theme;
    }
}
