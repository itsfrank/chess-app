import { useEffect, useState } from 'react';
import { EFFORTS, SETTING_LIMITS, type Settings } from '../../shared/protocol';
import { useSettings } from '../settings';

type NumberSetting = keyof typeof SETTING_LIMITS;
const NUMBERS: { name: NumberSetting; label: string; unit: string; help: string }[] = [
  {
    name: 'gameReviewDepth',
    label: 'Game review',
    unit: 'depth',
    help: 'The pass over every position of a game you review. Each step deeper roughly doubles the wait.',
  },
  {
    name: 'repertoireDepth',
    label: 'Repertoire',
    unit: 'depth',
    help: 'Every repertoire position and proposal.',
  },
  {
    name: 'analysisSeconds',
    label: 'Position on the board',
    unit: 'seconds',
    help: 'How long the engine thinks for the analysis panel and each of the companion’s checks.',
  },
];

/** The app-wide settings as a dialog over the page. Nothing changes until Save. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, models, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (changes: Partial<Settings>) => setDraft({ ...draft, ...changes });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The saved model stays selectable even when it is missing from the list.
  const choices = models.some(model => model.id === draft.model)
    ? models
    : [{ id: draft.model, name: draft.model }, ...models];
  const depthChanged =
    draft.gameReviewDepth !== settings.gameReviewDepth ||
    draft.repertoireDepth !== settings.repertoireDepth;

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await save(draft);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the settings');
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <form
        className="setup-popover settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onPointerDown={event => event.stopPropagation()}
        // Typing here must not reach the page's shortcuts or the chat's type-anywhere.
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Settings</h2>

        <label className="setup-field">
          <span className="label">chess.com username</span>
          <input
            type="text"
            value={draft.chesscomUsername}
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            placeholder="Username"
            autoFocus
            onChange={event => set({ chesscomUsername: event.target.value })}
          />
          <small>Whose games My games lists and repertoires are compared with.</small>
        </label>

        <div className="setup-field">
          <span className="label">Companion</span>
          <div className="settings-row">
            <select
              aria-label="Companion model"
              value={draft.model}
              onChange={event => set({ model: event.target.value })}
            >
              {choices.map(model => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Reasoning effort"
              value={draft.effort}
              onChange={event => set({ effort: event.target.value as Settings['effort'] })}
            >
              {EFFORTS.map(effort => (
                <option key={effort} value={effort}>
                  {effort} effort
                </option>
              ))}
            </select>
          </div>
          <small>Applies to conversations started after saving.</small>
        </div>

        <fieldset className="setup-field">
          <legend className="label">Stockfish</legend>
          {NUMBERS.map(({ name, label, unit, help }) => (
            <label key={name} className="settings-number" title={help}>
              <span>{label}</span>
              <input
                type="number"
                {...SETTING_LIMITS[name]}
                value={draft[name]}
                required
                onChange={event => set({ [name]: event.target.valueAsNumber })}
              />
              <span className="label">{unit}</span>
            </label>
          ))}
          <small>
            {depthChanged
              ? 'Positions are searched again at the new depth; results at the old depth are kept.'
              : 'Deeper is more reliable and slower.'}
          </small>
        </fieldset>

        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="start-game" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
