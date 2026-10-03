import { useNavigate } from "@tanstack/react-router";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Picks the model delegated child tasks use when the agent names no target.
 * Off keeps today's behavior: children run on the parent thread's model.
 */
export function DelegationSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const mixed = useScopedSettingsMixed(["delegationModelSelection"]);
  const selection = settings.delegationModelSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const firstAvailable = instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const activeInstanceId = selection?.instanceId ?? firstAvailable?.instanceId ?? null;
  const activeModel = selection?.model ?? firstAvailable?.models[0]?.slug ?? null;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    activeInstanceId,
    activeModel,
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);

  return (
    <SettingsSection id="delegation" title="Delegation">
      <SettingsRow
        serverScoped
        settingKeys={["delegationModelSelection"]}
        {...searchableSetting("delegation-model")}
        description="Model for child tasks an agent delegates without choosing one, such as a cheaper model for routine coding. Agents can still pick a stronger model per task. Off uses the parent thread's model."
        control={
          connectedEnvironments.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              Connect an environment to choose its delegation model.
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {selection !== null && activeInstanceId !== null && activeModel !== null ? (
                <ProviderModelPicker
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel="Delegation model"
                  {...(mixed ? { triggerLabel: "Mixed" } : {})}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: "/settings/providers",
                            search: { environmentId, instanceId },
                          });
                        },
                      }
                    : {})}
                  getModelDisabledReason={disabledReason}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = disabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: "Delegation model not saved",
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      delegationModelSelection: createModelSelection(instanceId, model),
                    });
                  }}
                />
              ) : null}
              <Switch
                mixed={mixed}
                checked={mixed ? false : selection !== null}
                disabled={selection === null && firstAvailable === undefined}
                onCheckedChange={(checked) =>
                  updateSettings({
                    delegationModelSelection:
                      checked && activeInstanceId !== null && activeModel !== null
                        ? createModelSelection(activeInstanceId, activeModel)
                        : null,
                  })
                }
                aria-label="Use a separate delegation model"
              />
            </div>
          )
        }
      />
    </SettingsSection>
  );
}
