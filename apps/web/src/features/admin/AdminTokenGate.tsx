/**
 * Token entry: the only way into `/admin`. Verifies the typed token against
 * `GET /api/admin/health` once before handing control back to the page — a
 * wrong token should land back here with a clear "that didn't work" instead
 * of rendering an empty, confusing queue (health has no query params and no
 * side effects, so it's a safe probe). `adminAuth()` on the API side 401s
 * identically whether `ADMIN_TOKEN` is unset or the token is simply wrong
 * (see its header comment) — this screen can't and doesn't try to tell
 * those apart either.
 */
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Card } from "@/ui/Surface";
import { Eyebrow } from "@/ui/Eyebrow";
import { Text } from "@/ui/Text";
import { Input } from "@/ui/Input";
import { Button } from "@/ui/Button";
import { getAdminHealth } from "@/api/admin";
import { ApiError } from "@/api/client";

export type AdminTokenGateProps = {
  onVerified: (token: string) => void;
};

export function AdminTokenGate({ onVerified }: AdminTokenGateProps): React.ReactElement {
  const [token, setToken] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    const trimmed = token.trim();
    if (trimmed === "" || checking) return;
    setChecking(true);
    setError(null);
    try {
      await getAdminHealth(trimmed);
      onVerified(trimmed);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That token didn't work." : "Couldn't reach Keepsake. Try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card style={{ gap: space.lg, maxWidth: 420, width: "100%", alignSelf: "center" }}>
      <View style={{ gap: space.sm }}>
        <Eyebrow>Admin</Eyebrow>
        <Text variant="displayMd">Enter the admin token</Text>
        <Text variant="body" color="textSecondary">
          Held only for this tab — never saved to this device.
        </Text>
      </View>
      <Input
        label="Admin token"
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        error={error ?? undefined}
        onSubmitEditing={() => void handleSubmit()}
      />
      <View style={{ flexDirection: "row" }}>
        <Button label="Enter" loading={checking} disabled={checking || token.trim() === ""} onPress={() => void handleSubmit()} />
      </View>
    </Card>
  );
}
