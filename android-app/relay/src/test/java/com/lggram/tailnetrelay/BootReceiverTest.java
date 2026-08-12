package com.lggram.tailnetrelay;

import android.content.Intent;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class BootReceiverTest {
    @Test
    public void startsForBootAndProfileResumeActions() {
        assertTrue(BootReceiver.shouldStartForAction(Intent.ACTION_BOOT_COMPLETED));
        assertTrue(BootReceiver.shouldStartForAction(Intent.ACTION_LOCKED_BOOT_COMPLETED));
        assertTrue(BootReceiver.shouldStartForAction(Intent.ACTION_USER_UNLOCKED));
        assertTrue(BootReceiver.shouldStartForAction(Intent.ACTION_MANAGED_PROFILE_AVAILABLE));
        assertTrue(BootReceiver.shouldStartForAction(Intent.ACTION_MANAGED_PROFILE_UNLOCKED));
        assertTrue(BootReceiver.shouldStartForAction(Intent.ACTION_MY_PACKAGE_REPLACED));
        assertTrue(BootReceiver.shouldStartForAction(RelayRestartScheduler.ACTION_WATCHDOG));
    }

    @Test
    public void ignoresUnrelatedBroadcasts() {
        assertFalse(BootReceiver.shouldStartForAction(null));
        assertFalse(BootReceiver.shouldStartForAction(Intent.ACTION_AIRPLANE_MODE_CHANGED));
    }
}
