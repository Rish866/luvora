import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { toUserMessage, errorCode } from "../lib/errors";

/**
 * Registration collects exactly the fields the backend requires: email,
 * password, displayName, dateOfBirth (YYYY-MM-DD), and the 18+ attestation
 * (ageConfirmed must be true). The server enforces the real 18+ age gate from
 * dateOfBirth — the checkbox alone is never trusted.
 */
export function RegisterPage(): JSX.Element {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!ageConfirmed) {
      setError("You must confirm you are 18 or older.");
      return;
    }
    setSubmitting(true);
    try {
      await register({
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        dateOfBirth,
        ageConfirmed: true,
      });
      navigate("/app/profile", { replace: true });
    } catch (err) {
      const code = errorCode(err);
      if (code === "AGE_RESTRICTED") {
        setError("You must be at least 18 years old to use Luvora.");
      } else {
        setError(toUserMessage(err, "Could not create your account."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit} aria-label="Create account">
        <h1 className="auth-brand">Luvora</h1>
        <p className="auth-sub">Create your account.</p>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span>Display name</span>
          <input
            name="displayName"
            maxLength={50}
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Date of birth</span>
          <input
            type="date"
            name="dateOfBirth"
            required
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
          />
        </label>

        <label className="field field--check">
          <input
            type="checkbox"
            name="ageConfirmed"
            checked={ageConfirmed}
            onChange={(e) => setAgeConfirmed(e.target.checked)}
          />
          <span>I confirm I am 18 years of age or older.</span>
        </label>

        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create account"}
        </button>

        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
