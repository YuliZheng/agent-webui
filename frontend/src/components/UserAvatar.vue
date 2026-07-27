<script setup lang="ts">
import { useUiStore } from "../stores/ui.js";
import { useUserAvatarStore } from "../stores/user-avatar.js";
import { userInitials } from "../util/user-initials.js";

const ui = useUiStore();
const avatar = useUserAvatarStore();

function hideBrokenAvatar(event: Event) {
  (event.currentTarget as HTMLImageElement).style.display = "none";
}
</script>

<template>
  <button
    type="button"
    class="cw-user-avatar-button"
    title="更换我的头像"
    aria-label="更换我的头像"
    @click.stop="avatar.edit()"
  >
    <span class="cw-message-avatar-fallback">{{ userInitials(ui.home) }}</span>
    <img
      :key="avatar.revision"
      :src="avatar.src"
      alt=""
      draggable="false"
      loading="lazy"
      decoding="async"
      @error="hideBrokenAvatar"
    />
    <span class="cw-user-avatar-edit-hint" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M8.4 7.5 9.7 5.7h4.6l1.3 1.8h2.1a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H6.3a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2h2.1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <circle cx="12" cy="13" r="3.1" stroke="currentColor" stroke-width="1.8"/>
      </svg>
    </span>
  </button>
</template>
