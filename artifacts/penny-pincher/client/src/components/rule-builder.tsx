import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TrendingUp, TrendingDown, Zap, Shield, Target, Rocket, Coins, Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";

export interface RuleValues {
  takeProfitThresholds: number[];
  takeProfitPercentages: number[];
  takeProfitEnabled?: boolean[];
  stopLossPercent: number;
  stopLossMode: "auto" | "alert";
}

interface RuleBuilderProps {
  values: RuleValues;
  onChange: (values: RuleValues) => void;
  onSave?: () => void;
  isSaving?: boolean;
  showSaveButton?: boolean;
  disabled?: boolean;
  compact?: boolean;
  testIdPrefix?: string;
  showPresets?: boolean;
}

const DEFAULT_VALUES: RuleValues = {
  takeProfitThresholds: [4, 10, 25, 100],
  takeProfitPercentages: [25, 25, 25, 25],
  takeProfitEnabled: [true, true, true, true],
  stopLossPercent: 50,
  stopLossMode: "auto",
};

interface RulePreset {
  id: string;
  name: string;
  description: string;
  icon: typeof Zap;
  values: RuleValues;
}

export const RULE_PRESETS: RulePreset[] = [
  {
    id: "conservative",
    name: "Conservative",
    description: "Quick profits, tight stop-loss",
    icon: Shield,
    values: {
      takeProfitThresholds: [2, 3, 5, 10],
      takeProfitPercentages: [40, 30, 20, 10],
      stopLossPercent: 30,
      stopLossMode: "auto",
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Standard 4-tier exit strategy",
    icon: Target,
    values: {
      takeProfitThresholds: [4, 10, 25, 100],
      takeProfitPercentages: [25, 25, 25, 25],
      stopLossPercent: 50,
      stopLossMode: "auto",
    },
  },
  {
    id: "moonshot",
    name: "Moonshot",
    description: "Hold for bigger gains",
    icon: Rocket,
    values: {
      takeProfitThresholds: [10, 25, 50, 100],
      takeProfitPercentages: [20, 20, 30, 30],
      stopLossPercent: 60,
      stopLossMode: "alert",
    },
  },
  {
    id: "degen",
    name: "Degen",
    description: "High risk, ride or die",
    icon: Zap,
    values: {
      takeProfitThresholds: [25, 50, 100, 500],
      takeProfitPercentages: [10, 20, 30, 40],
      stopLossPercent: 80,
      stopLossMode: "alert",
    },
  },
  {
    id: "scalper",
    name: "Scalper",
    description: "Fast in, fast out",
    icon: Coins,
    values: {
      takeProfitThresholds: [1.5, 2, 3, 5],
      takeProfitPercentages: [50, 30, 15, 5],
      stopLossPercent: 20,
      stopLossMode: "auto",
    },
  },
];

interface TakeProfitTier {
  threshold: number;
  percent: number;
  enabled: boolean;
}

export function RuleBuilder({
  values,
  onChange,
  onSave,
  isSaving = false,
  showSaveButton = true,
  disabled = false,
  compact = false,
  testIdPrefix = "",
  showPresets = false,
}: RuleBuilderProps) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";
  
  const initTiers = (): TakeProfitTier[] => {
    const thresholds = values.takeProfitThresholds || DEFAULT_VALUES.takeProfitThresholds;
    const percents = values.takeProfitPercentages || DEFAULT_VALUES.takeProfitPercentages;
    const enabled = values.takeProfitEnabled || thresholds.map(() => true);
    return thresholds.map((t, i) => ({ threshold: t, percent: percents[i] || 0, enabled: enabled[i] ?? true }));
  };

  const [tiers, setTiers] = useState<TakeProfitTier[]>(initTiers);
  const [stopLoss, setStopLoss] = useState(
    (values.stopLossPercent ?? DEFAULT_VALUES.stopLossPercent).toString()
  );
  const [stopLossMode, setStopLossMode] = useState<"auto" | "alert">(
    values.stopLossMode || DEFAULT_VALUES.stopLossMode
  );

  const applyPreset = (preset: RulePreset) => {
    const newTiers = preset.values.takeProfitThresholds.map((t, i) => ({
      threshold: t,
      percent: preset.values.takeProfitPercentages[i] || 0,
      enabled: true,
    }));
    setTiers(newTiers);
    setStopLoss(preset.values.stopLossPercent.toString());
    setStopLossMode(preset.values.stopLossMode);
    emitChange(newTiers, preset.values.stopLossPercent, preset.values.stopLossMode);
  };

  const getActivePreset = (): string | null => {
    for (const preset of RULE_PRESETS) {
      const thresholdsMatch = 
        JSON.stringify(values.takeProfitThresholds) === JSON.stringify(preset.values.takeProfitThresholds);
      const percentsMatch = 
        JSON.stringify(values.takeProfitPercentages) === JSON.stringify(preset.values.takeProfitPercentages);
      const slMatch = values.stopLossPercent === preset.values.stopLossPercent;
      const modeMatch = values.stopLossMode === preset.values.stopLossMode;
      if (thresholdsMatch && percentsMatch && slMatch && modeMatch) {
        return preset.id;
      }
    }
    return null;
  };

  useEffect(() => {
    const thresholds = values.takeProfitThresholds || DEFAULT_VALUES.takeProfitThresholds;
    const percents = values.takeProfitPercentages || DEFAULT_VALUES.takeProfitPercentages;
    const enabled = values.takeProfitEnabled || thresholds.map(() => true);
    setTiers(thresholds.map((t, i) => ({ 
      threshold: t, 
      percent: percents[i] || 0, 
      enabled: enabled[i] ?? true 
    })));
    setStopLoss((values.stopLossPercent ?? DEFAULT_VALUES.stopLossPercent).toString());
    setStopLossMode(values.stopLossMode || DEFAULT_VALUES.stopLossMode);
  }, [values]);

  const emitChange = (newTiers: TakeProfitTier[], sl: number, mode: "auto" | "alert") => {
    onChange({
      takeProfitThresholds: newTiers.map(t => t.threshold),
      takeProfitPercentages: newTiers.map(t => t.percent),
      takeProfitEnabled: newTiers.map(t => t.enabled),
      stopLossPercent: sl,
      stopLossMode: mode,
    });
  };

  const updateTier = (index: number, field: "threshold" | "percent", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) && value !== "") return;
    
    const newTiers = [...tiers];
    newTiers[index] = { ...newTiers[index], [field]: value === "" ? 0 : num };
    setTiers(newTiers);
    emitChange(newTiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, stopLossMode);
  };

  const addTier = () => {
    if (tiers.length >= 8) return;
    const enabledTiers = tiers.filter(t => t.enabled);
    const lastThreshold = enabledTiers.length > 0 ? enabledTiers[enabledTiers.length - 1].threshold : 1;
    const newTier = { threshold: lastThreshold * 2, percent: 10, enabled: true };
    const newTiers = [...tiers, newTier];
    setTiers(newTiers);
    emitChange(newTiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, stopLossMode);
  };

  const toggleTier = (index: number) => {
    const newTiers = [...tiers];
    newTiers[index] = { ...newTiers[index], enabled: !newTiers[index].enabled };
    setTiers(newTiers);
    emitChange(newTiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, stopLossMode);
  };

  const deleteTier = (index: number) => {
    if (tiers.length <= 1) return;
    const newTiers = tiers.filter((_, i) => i !== index);
    setTiers(newTiers);
    emitChange(newTiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, stopLossMode);
  };

  const moveTier = (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= tiers.length) return;
    
    const newTiers = [...tiers];
    [newTiers[index], newTiers[newIndex]] = [newTiers[newIndex], newTiers[index]];
    setTiers(newTiers);
    emitChange(newTiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, stopLossMode);
  };

  const handleStopLossChange = (value: string) => {
    setStopLoss(value);
    const sl = parseFloat(value);
    if (!isNaN(sl)) {
      emitChange(tiers, sl, stopLossMode);
    }
  };

  const handleModeChange = (value: "auto" | "alert") => {
    setStopLossMode(value);
    emitChange(tiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, value);
  };

  const handleSave = () => {
    emitChange(tiers, parseFloat(stopLoss) || DEFAULT_VALUES.stopLossPercent, stopLossMode);
    if (onSave) {
      setTimeout(() => onSave(), 0);
    }
  };

  const enabledTiersCount = () => tiers.filter(t => t.enabled).length;
  const percentsTotal = () => tiers.filter(t => t.enabled).reduce((sum, t) => sum + t.percent, 0);
  const tiersValid = () => enabledTiersCount() > 0 && tiers.filter(t => t.enabled).every(t => t.threshold > 0 && t.percent >= 0);
  const activePreset = getActivePreset();

  return (
    <div className="space-y-4">
      {showPresets && !compact && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Quick Presets</Label>
          <div className="grid grid-cols-5 gap-2">
            {RULE_PRESETS.map((preset) => {
              const Icon = preset.icon;
              const isActive = activePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  disabled={disabled}
                  className={`flex flex-col items-center p-2 rounded-lg border text-center transition-colors hover-elevate ${
                    isActive 
                      ? "border-primary bg-primary/10" 
                      : "border-border"
                  }`}
                  data-testid={`${prefix}preset-${preset.id}`}
                >
                  <Icon className={`h-4 w-4 mb-1 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-xs font-medium">{preset.name}</span>
                </button>
              );
            })}
          </div>
          {activePreset && (
            <p className="text-xs text-muted-foreground text-center">
              {RULE_PRESETS.find(p => p.id === activePreset)?.description}
            </p>
          )}
        </div>
      )}

      <div className={`space-y-3 rounded-lg border ${compact ? "p-2" : "p-3"}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-500" />
            <Label className="text-sm font-medium">Take Profit Tiers</Label>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={addTier}
            disabled={disabled || tiers.length >= 8}
            data-testid={`${prefix}button-add-tier`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-2">
          {tiers.map((tier, index) => (
            <div 
              key={index} 
              className={`flex items-center gap-2 p-2 rounded border ${tier.enabled ? "bg-muted/30" : "bg-muted/10 opacity-60"}`}
              data-testid={`${prefix}tier-${index}`}
            >
              <Switch
                checked={tier.enabled}
                onCheckedChange={() => toggleTier(index)}
                disabled={disabled}
                data-testid={`${prefix}switch-tier-${index}-enable`}
              />
              
              <div className="flex flex-col gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => moveTier(index, "up")}
                  disabled={disabled || index === 0}
                  data-testid={`${prefix}button-tier-${index}-up`}
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => moveTier(index, "down")}
                  disabled={disabled || index === tiers.length - 1}
                  data-testid={`${prefix}button-tier-${index}-down`}
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              
              <div className="flex-1 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs text-muted-foreground">At</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      step="0.1"
                      value={tier.threshold}
                      onChange={(e) => updateTier(index, "threshold", e.target.value)}
                      disabled={disabled || !tier.enabled}
                      className="h-8"
                      data-testid={`${prefix}input-tier-${index}-threshold`}
                    />
                    <span className="text-xs text-muted-foreground">x</span>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Sell</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      step="1"
                      value={tier.percent}
                      onChange={(e) => updateTier(index, "percent", e.target.value)}
                      disabled={disabled || !tier.enabled}
                      className="h-8"
                      data-testid={`${prefix}input-tier-${index}-percent`}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => deleteTier(index)}
                disabled={disabled || tiers.length <= 1}
                className="text-muted-foreground hover:text-destructive"
                data-testid={`${prefix}button-tier-${index}-delete`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {percentsTotal() !== 100 && (
          <p className="text-xs text-amber-500">
            Total: {percentsTotal()}% (typically sums to 100%)
          </p>
        )}
      </div>

      <div className={`space-y-3 rounded-lg border ${compact ? "p-2" : "p-3"}`}>
        <div className="flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-red-500" />
          <Label className="text-sm font-medium">Stop Loss</Label>
        </div>
        <div className={compact ? "space-y-2" : "grid grid-cols-2 gap-3"}>
          <div>
            <Label className="text-xs text-muted-foreground">Trigger at (% down)</Label>
            <Input
              value={stopLoss}
              onChange={(e) => handleStopLossChange(e.target.value)}
              placeholder="50"
              className="mt-1"
              disabled={disabled}
              data-testid={`${prefix}input-stop-loss`}
            />
            <p className="text-xs text-muted-foreground mt-1">Sell if price drops by this %</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Mode</Label>
            <Select 
              value={stopLossMode} 
              onValueChange={(v) => handleModeChange(v as "auto" | "alert")}
              disabled={disabled}
            >
              <SelectTrigger className="mt-1" data-testid={`${prefix}select-stop-loss-mode`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (sell immediately)</SelectItem>
                <SelectItem value="alert">Alert (notify first)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {showSaveButton && onSave && (
        <Button
          onClick={handleSave}
          disabled={isSaving || disabled || !tiersValid()}
          className="w-full"
          data-testid={`${prefix}button-save-rules`}
        >
          {isSaving ? "Saving..." : "Save Rules"}
        </Button>
      )}
    </div>
  );
}

export function RuleSummary({ values, className = "", testIdPrefix = "" }: { values: Partial<RuleValues>; className?: string; testIdPrefix?: string }) {
  const thresholds = values.takeProfitThresholds || DEFAULT_VALUES.takeProfitThresholds;
  const percents = values.takeProfitPercentages || DEFAULT_VALUES.takeProfitPercentages;
  const enabled = values.takeProfitEnabled || thresholds.map(() => true);
  const sl = values.stopLossPercent ?? DEFAULT_VALUES.stopLossPercent;
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  const enabledTiers = thresholds
    .map((t, i) => ({ threshold: t, percent: percents[i] || 0, enabled: enabled[i] ?? true }))
    .filter(t => t.enabled);

  return (
    <div className={`text-xs text-muted-foreground space-y-1 ${className}`} data-testid={`${prefix}rule-summary`}>
      <div className="flex items-center gap-1">
        <TrendingUp className="h-3 w-3 text-green-500" />
        <span>
          Take-profit: {enabledTiers.map(t => `${t.threshold}x→${t.percent}%`).join(", ")}
          {enabledTiers.length === 0 && "None"}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <TrendingDown className="h-3 w-3 text-red-500" />
        <span>Stop-loss: {sl}% ({values.stopLossMode || "auto"})</span>
      </div>
    </div>
  );
}
