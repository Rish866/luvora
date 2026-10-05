import type {
  ProfileView,
  ProfileEditableFields,
  DiscoveryCandidate,
  DiscoveryActionResult,
  MatchSummary,
  MatchListResponse,
  ChatMessage,
  UploadIntent,
  MediaAssetView,
} from "@luvora/shared";
import type { ApiClient } from "./client";

/** The authenticated-identity view returned by GET /api/auth/me. */
export interface MeView {
  id: string;
  email: string;
  age: number;
  ageConfirmed: boolean;
  emailVerified: boolean;
}

/** Tokens returned by login/register/refresh. */
export interface AuthTokens {
  userId?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  dateOfBirth: string; // YYYY-MM-DD
  ageConfirmed: true;
}

export interface DiscoveryFeed {
  candidates: DiscoveryCandidate[];
  nextCursor: string | null;
}

export interface MessageHistory {
  conversationId: string;
  messages: ChatMessage[];
  nextCursor: string | null;
}

/**
 * Typed, resource-oriented facade over the ApiClient. One place that knows the
 * backend route shapes; components call these, never raw fetch. All DTOs come
 * from @luvora/shared so there is no manual DTO duplication.
 */
export function createEndpoints(client: ApiClient) {
  return {
    auth: {
      register: (input: RegisterInput) =>
        client.post<AuthTokens>("/api/auth/register", input, { anonymous: true }),
      login: (email: string, password: string) =>
        client.post<AuthTokens>("/api/auth/login", { email, password }, { anonymous: true }),
      logout: (refreshToken: string) =>
        client.post<{ loggedOut: boolean }>("/api/auth/logout", { refreshToken }, {
          anonymous: true,
        }),
      me: () => client.get<MeView>("/api/auth/me"),
    },

    profile: {
      get: () => client.get<{ profile: ProfileView }>("/api/profile").then((r) => r.profile),
      update: (fields: Partial<ProfileEditableFields>) =>
        client.patch<{ profile: ProfileView }>("/api/profile", fields).then((r) => r.profile),
      associatePhoto: (mediaId: string) =>
        client
          .post<{ profile: ProfileView }>("/api/profile/photos", { mediaId })
          .then((r) => r.profile),
      setPrimaryPhoto: (photoId: string) =>
        client
          .post<{ profile: ProfileView }>(`/api/profile/photos/${photoId}/primary`)
          .then((r) => r.profile),
      reorderPhotos: (photoIds: string[]) =>
        client
          .put<{ profile: ProfileView }>("/api/profile/photos/order", { photoIds })
          .then((r) => r.profile),
      deletePhoto: (photoId: string) =>
        client
          .delete<{ profile: ProfileView }>(`/api/profile/photos/${photoId}`)
          .then((r) => r.profile),
    },

    media: {
      createIntent: (input: { filename?: string; mimeType: string; sizeBytes: number }) =>
        client.post<UploadIntent>("/api/media", { ...input, context: "profile" }),
      /** PUT raw bytes to the upload URL. Returns the finalized asset view. */
      uploadBytes: (mediaId: string, data: Blob, mimeType: string) =>
        client.putBytes<MediaAssetView>(`/api/media/${mediaId}/content`, data, mimeType),
    },

    discovery: {
      feed: (opts: { limit?: number; cursor?: string } = {}) => {
        const q = new URLSearchParams();
        if (opts.limit) q.set("limit", String(opts.limit));
        if (opts.cursor) q.set("cursor", opts.cursor);
        const qs = q.toString();
        return client.get<DiscoveryFeed>(`/api/discovery${qs ? `?${qs}` : ""}`);
      },
      like: (userId: string) =>
        client.post<DiscoveryActionResult>(`/api/discovery/${userId}/like`),
      pass: (userId: string) =>
        client.post<DiscoveryActionResult>(`/api/discovery/${userId}/pass`),
    },

    matches: {
      list: () => client.get<MatchListResponse>("/api/matches"),
      get: (matchId: string) =>
        client.get<{ match: MatchSummary }>(`/api/matches/${matchId}`).then((r) => r.match),
    },

    messages: {
      history: (matchId: string, opts: { limit?: number; cursor?: string } = {}) => {
        const q = new URLSearchParams();
        if (opts.limit) q.set("limit", String(opts.limit));
        if (opts.cursor) q.set("cursor", opts.cursor);
        const qs = q.toString();
        return client.get<MessageHistory>(
          `/api/matches/${matchId}/messages${qs ? `?${qs}` : ""}`,
        );
      },
      send: (matchId: string, body: string, clientMessageId?: string) =>
        client
          .post<{ message: ChatMessage }>(`/api/matches/${matchId}/messages`, {
            body,
            ...(clientMessageId ? { clientMessageId } : {}),
          })
          .then((r) => r.message),
    },

    conversations: {
      read: (conversationId: string) =>
        client.post<{ conversationId: string; lastReadMessageId: string | null; unreadCount: number }>(
          `/api/conversations/${conversationId}/read`,
        ),
      unreadCount: (conversationId: string) =>
        client.get<{ conversationId: string; unreadCount: number }>(
          `/api/conversations/${conversationId}/unread-count`,
        ),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
