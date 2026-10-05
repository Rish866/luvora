import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PROFILE_LIMITS, type ProfileView } from "@luvora/shared";
import { useApi } from "../api/ApiContext";
import { useAuth } from "../auth/AuthContext";
import { AuthedImage } from "../components/AuthedImage";
import { Spinner, ErrorState } from "../components/states";
import { toUserMessage } from "../lib/errors";

/** Parse a comma-separated input into a trimmed, de-duplicated list. */
function parseList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

export function ProfilePage(): JSX.Element {
  const api = useApi();
  const { me, logout } = useAuth();

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileView | null>(null);

  // Edit form fields.
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [interests, setInterests] = useState("");
  const [fantasyPreferences, setFantasyPreferences] = useState("");
  const [discoverable, setDiscoverable] = useState(true);
  const [ageVisible, setAgeVisible] = useState(true);
  const [onlineStatusVisible, setOnlineStatusVisible] = useState(true);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(true);

  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const applyProfile = useCallback((p: ProfileView) => {
    setProfile(p);
    setDisplayName(p.displayName);
    setBio(p.bio ?? "");
    setInterests(p.interests.join(", "));
    setFantasyPreferences(p.fantasyPreferences.join(", "));
    setDiscoverable(p.discoverable);
    setAgeVisible(p.ageVisible);
    setOnlineStatusVisible(p.onlineStatusVisible);
    setReadReceiptsEnabled(p.readReceiptsEnabled);
  }, []);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      applyProfile(await api.profile.get());
      setStatus("ready");
    } catch (err) {
      setError(toUserMessage(err, "Could not load your profile."));
      setStatus("error");
    }
  }, [api, applyProfile]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setSaveError(null);
      setSavedBanner(null);
      try {
        const updated = await api.profile.update({
          displayName: displayName.trim(),
          bio: bio.trim() === "" ? null : bio.trim(),
          interests: parseList(interests),
          fantasyPreferences: parseList(fantasyPreferences),
          discoverable,
          ageVisible,
          onlineStatusVisible,
          readReceiptsEnabled,
        });
        applyProfile(updated);
        setSavedBanner("Profile saved.");
      } catch (err) {
        setSaveError(toUserMessage(err, "Could not save your profile."));
      } finally {
        setSaving(false);
      }
    },
    [
      api,
      displayName,
      bio,
      interests,
      fantasyPreferences,
      discoverable,
      ageVisible,
      onlineStatusVisible,
      readReceiptsEnabled,
      applyProfile,
    ],
  );

  // Photo: upload via the media pipeline (context=profile), then associate.
  const onPickPhoto = useCallback(
    async (file: File) => {
      setPhotoBusy(true);
      setPhotoError(null);
      try {
        const intent = await api.media.createIntent({
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        });
        await api.media.uploadBytes(intent.mediaId, file, file.type);
        const updated = await api.profile.associatePhoto(intent.mediaId);
        applyProfile(updated);
      } catch (err) {
        setPhotoError(toUserMessage(err, "Could not upload that photo."));
      } finally {
        setPhotoBusy(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [api, applyProfile],
  );

  const setPrimary = useCallback(
    async (photoId: string) => {
      setPhotoBusy(true);
      setPhotoError(null);
      try {
        applyProfile(await api.profile.setPrimaryPhoto(photoId));
      } catch (err) {
        setPhotoError(toUserMessage(err, "Could not set the primary photo."));
      } finally {
        setPhotoBusy(false);
      }
    },
    [api, applyProfile],
  );

  const deletePhoto = useCallback(
    async (photoId: string) => {
      setPhotoBusy(true);
      setPhotoError(null);
      try {
        applyProfile(await api.profile.deletePhoto(photoId));
      } catch (err) {
        setPhotoError(toUserMessage(err, "Could not delete that photo."));
      } finally {
        setPhotoBusy(false);
      }
    },
    [api, applyProfile],
  );

  const movePhoto = useCallback(
    async (index: number, dir: -1 | 1) => {
      if (!profile) return;
      const ids = profile.photos.map((p) => p.id);
      const target = index + dir;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      setPhotoBusy(true);
      setPhotoError(null);
      try {
        applyProfile(await api.profile.reorderPhotos(ids));
      } catch (err) {
        setPhotoError(toUserMessage(err, "Could not reorder photos."));
      } finally {
        setPhotoBusy(false);
      }
    },
    [api, profile, applyProfile],
  );

  if (status === "loading") return <Spinner label="Loading your profile…" />;
  if (status === "error" || !profile) return <ErrorState message={error ?? "Error"} onRetry={load} />;

  const canAddPhoto = profile.photos.length < PROFILE_LIMITS.MAX_PHOTOS;

  return (
    <section className="page page--profile" aria-label="Profile">
      <header className="page__header">
        <h1>Profile</h1>
        {me && <p className="muted">{me.email}</p>}
      </header>

      {/* ---- Photos ---- */}
      <div className="card">
        <h2>Photos</h2>
        {photoError && (
          <div className="form-error" role="alert">
            {photoError}
          </div>
        )}
        <ul className="photo-grid">
          {profile.photos.map((p, i) => (
            <li key={p.id} className={`photo-tile${p.isPrimary ? " is-primary" : ""}`}>
              <AuthedImage
                src={p.thumbnailUrl ?? p.url}
                alt={`Photo ${i + 1}`}
                className="photo-tile__img"
              />
              {p.isPrimary && <span className="photo-tile__primary-tag">Primary</span>}
              {p.status !== "READY" && <span className="photo-tile__pending">{p.status}</span>}
              <div className="photo-tile__actions">
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={photoBusy || i === 0}
                  onClick={() => movePhoto(i, -1)}
                  aria-label="Move left"
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={photoBusy || i === profile.photos.length - 1}
                  onClick={() => movePhoto(i, 1)}
                  aria-label="Move right"
                >
                  ▶
                </button>
                {!p.isPrimary && (
                  <button
                    type="button"
                    className="btn btn--xs"
                    disabled={photoBusy}
                    onClick={() => setPrimary(p.id)}
                  >
                    Primary
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  disabled={photoBusy}
                  onClick={() => deletePhoto(p.id)}
                  aria-label="Delete photo"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="photo-add">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={!canAddPhoto || photoBusy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickPhoto(f);
            }}
            aria-label="Add a profile photo"
          />
          {photoBusy && <span className="muted">Working…</span>}
          {!canAddPhoto && <span className="muted">Maximum {PROFILE_LIMITS.MAX_PHOTOS} photos.</span>}
        </div>
      </div>

      {/* ---- Editable fields ---- */}
      <form className="card" onSubmit={onSave} aria-label="Edit profile">
        <h2>About you</h2>
        {savedBanner && (
          <div className="banner banner--success" role="status">
            {savedBanner}
          </div>
        )}
        {saveError && (
          <div className="form-error" role="alert">
            {saveError}
          </div>
        )}

        <label className="field">
          <span>Display name</span>
          <input
            value={displayName}
            maxLength={PROFILE_LIMITS.DISPLAY_NAME_MAX}
            required
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Bio</span>
          <textarea
            value={bio}
            maxLength={PROFILE_LIMITS.BIO_MAX}
            rows={3}
            onChange={(e) => setBio(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Interests (comma-separated)</span>
          <input value={interests} onChange={(e) => setInterests(e.target.value)} />
        </label>

        <label className="field">
          <span>Fantasy preferences (comma-separated)</span>
          <input
            value={fantasyPreferences}
            onChange={(e) => setFantasyPreferences(e.target.value)}
          />
        </label>

        <fieldset className="toggles">
          <legend>Privacy</legend>
          <label className="field field--check">
            <input
              type="checkbox"
              checked={discoverable}
              onChange={(e) => setDiscoverable(e.target.checked)}
            />
            <span>Discoverable (appear in others' Discover)</span>
          </label>
          <label className="field field--check">
            <input
              type="checkbox"
              checked={ageVisible}
              onChange={(e) => setAgeVisible(e.target.checked)}
            />
            <span>Show my age</span>
          </label>
          <label className="field field--check">
            <input
              type="checkbox"
              checked={onlineStatusVisible}
              onChange={(e) => setOnlineStatusVisible(e.target.checked)}
            />
            <span>Show my online status</span>
          </label>
          <label className="field field--check">
            <input
              type="checkbox"
              checked={readReceiptsEnabled}
              onChange={(e) => setReadReceiptsEnabled(e.target.checked)}
            />
            <span>Send read receipts</span>
          </label>
        </fieldset>

        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </form>

      <div className="card card--muted">
        <button type="button" className="btn btn--ghost" onClick={() => void logout()}>
          Log out
        </button>
      </div>
    </section>
  );
}
