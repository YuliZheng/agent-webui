package com.lggram.tailnetrelay;

import android.content.Context;
import android.os.Build;
import android.os.UserManager;

final class ProfileMode {
    private ProfileMode() {
    }

    static boolean isManagedProfile(Context context) {
        UserManager userManager = context.getSystemService(UserManager.class);
        if (userManager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return userManager.isManagedProfile();
        }

        // Android 8-10 do not expose the no-argument managed-profile check.
        // This app is installed only for the owner and its work profile, so a
        // non-system user is the work-side relay on those releases.
        return !userManager.isSystemUser();
    }
}
