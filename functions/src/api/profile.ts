import { getDownloadURL, getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "../store.js";
import { callableOptions, guarded, requireAccount, requireAuth } from "./common.js";

const MAX_AVATAR_BYTES = 1024 * 1024;
const IMAGE = /^data:image\/(png|jpeg|webp);base64,(.+)$/;

// Updates the display name and/or profile photo. Photos are stored in our bucket so they always load.
export const updateProfile = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    await requireAccount(uid);
    const { displayName, avatarDataUrl } = (req.data ?? {}) as { displayName?: string; avatarDataUrl?: string };
    const update: Record<string, string> = {};

    if (displayName !== undefined) {
      const name = String(displayName).replace(/\s+/g, " ").trim();
      if (name.length < 1 || name.length > 40) throw new HttpsError("invalid-argument", "Name must be 1 to 40 characters.");
      update.displayName = name;
      update.displayNameLower = name.toLowerCase();
    }

    if (avatarDataUrl !== undefined) {
      const m = IMAGE.exec(String(avatarDataUrl));
      if (!m) throw new HttpsError("invalid-argument", "Upload a PNG, JPEG or WebP image.");
      const bytes = Buffer.from(m[2], "base64");
      if (bytes.length > MAX_AVATAR_BYTES) throw new HttpsError("invalid-argument", "That photo is over 1 MB.");
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const file = getStorage().bucket().file(`avatars/${uid}/${Date.now()}.${ext}`);
      await file.save(bytes, { contentType: `image/${m[1]}`, resumable: false, metadata: { cacheControl: "public, max-age=31536000" } });
      update.avatarUrl = await getDownloadURL(file);
    }

    if (!Object.keys(update).length) throw new HttpsError("invalid-argument", "Nothing to update.");
    await db().collection("users").doc(uid).update(update);
    return update;
  }),
);
