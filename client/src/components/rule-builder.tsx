import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingUp, TrendingDown } from "lucide-react";

export interface RuleValues {
  takeProfitThresholds: number[];
  takeProfitPercentages: number[];
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
}

const DEFAULT_VALUES: RuleValues = {
  takeProfitThresholds: [4, 10, 25, 100],
  takeProfitPercentages: [25, 25, 25, 25],
  stopLossPercent: 50,
  stopLossMode: "auto",
};

export function RuleBuilder({
  values,
  onChange,
  onSave,
  isSaving = false,
  showSaveButton = true,
  disabled = false,
  compact = false,
  testIdPrefix = "",
}: RuleBuilderProps) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";
  const [tpThresholds, setTpThresholds] = useState(
    (values.takeProfitThresholds || DEFAULT_VALUES.takeProfitThresholds).join(", ")
  );
  const [tpPercents, setTpPercents] = useState(
    (values.takeProfitPercentages || DEFAULT_VALUES.takeProfitPercentages).join(", ")
  );
  const [stopLoss, setStopLoss] = useState(
    (values.stopLossPercent ?? DEFAULT_VALUES.stopLossPercent).toString()
  );
  const [stopLossMode, setStopLossMode] = useState<"auto" | "alert">(
    values.stopLossMode || DEFAULT_VALUES.stopLossMode
  );

  useEffect(() => {
    setTpThresholds((values.takeProfitThresholds || DEFAULT_VALUES.takeProfitThresholds).join(", "));
    setTpPercents((values.takeProfitPercentages || DEFAULT_VALUES.takeProfitPercentages).join(", "));
    setStopLoss((values.stopLossPercent ?? DEFAULT_VALUES.stopLossPercent).toString());
    setStopLossMode(values.stopLossMode || DEFAULT_VALUES.stopLossMode);
  }, [values]);

  const parseThresholds = () => tpThresholds.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
  const parsePercents = () => tpPercents.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

  const handleChange = () => {
    const thresholds = parseThresholds();
    const percents = parsePercents();
    const sl = parseFloat(stopLoss);

    onChange({
      takeProfitThresholds: thresholds.length > 0 ? thresholds : DEFAULT_VALUES.takeProfitThresholds,
      takeProfitPercentages: percents.length > 0 ? percents : DEFAULT_VALUES.takeProfitPercentages,
      stopLossPercent: !isNaN(sl) ? sl : DEFAULT_VALUES.stopLossPercent,
      stopLossMode,
    });
  };

  const handleThresholdsChange = (value: string) => {
    setTpThresholds(value);
    const thresholds = value.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    const percents = parsePercents();
    const sl = parseFloat(stopLoss);
    onChange({
      takeProfitThresholds: thresholds.length > 0 ? thresholds : DEFAULT_VALUES.takeProfitThresholds,
      takeProfitPercentages: percents.length > 0 ? percents : DEFAULT_VALUES.takeProfitPercentages,
      stopLossPercent: !isNaN(sl) ? sl : DEFAULT_VALUES.stopLossPercent,
      stopLossMode,
    });
  };

  const handlePercentsChange = (value: string) => {
    setTpPercents(value);
    const thresholds = parseThresholds();
    const percents = value.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    const sl = parseFloat(stopLoss);
    onChange({
      takeProfitThresholds: thresholds.length > 0 ? thresholds : DEFAULT_VALUES.takeProfitThresholds,
      takeProfitPercentages: percents.length > 0 ? percents : DEFAULT_VALUES.takeProfitPercentages,
      stopLossPercent: !isNaN(sl) ? sl : DEFAULT_VALUES.stopLossPercent,
      stopLossMode,
    });
  };

  const handleStopLossChange = (value: string) => {
    setStopLoss(value);
    const thresholds = parseThresholds();
    const percents = parsePercents();
    const sl = parseFloat(value);
    onChange({
      takeProfitThresholds: thresholds.length > 0 ? thresholds : DEFAULT_VALUES.takeProfitThresholds,
      takeProfitPercentages: percents.length > 0 ? percents : DEFAULT_VALUES.takeProfitPercentages,
      stopLossPercent: !isNaN(sl) ? sl : DEFAULT_VALUES.stopLossPercent,
      stopLossMode,
    });
  };

  const handleModeChange = (value: "auto" | "alert") => {
    setStopLossMode(value);
    const thresholds = parseThresholds();
    const percents = parsePercents();
    const sl = parseFloat(stopLoss);

    onChange({
      takeProfitThresholds: thresholds.length > 0 ? thresholds : DEFAULT_VALUES.takeProfitThresholds,
      takeProfitPercentages: percents.length > 0 ? percents : DEFAULT_VALUES.takeProfitPercentages,
      stopLossPercent: !isNaN(sl) ? sl : DEFAULT_VALUES.stopLossPercent,
      stopLossMode: value,
    });
  };

  const handleBlur = () => {
    handleChange();
  };

  const handleSave = () => {
    handleChange();
    if (onSave) {
      setTimeout(() => onSave(), 0);
    }
  };

  const thresholdsValid = () => {
    const thresholds = parseThresholds();
    const percents = parsePercents();
    return thresholds.length > 0 && thresholds.length === percents.length;
  };

  const percentsTotal = () => {
    const percents = parsePercents();
    return percents.reduce((sum, p) => sum + p, 0);
  };

  return (
    <div className="space-y-4">
      <div className={`space-y-3 p-3 rounded-lg border ${compact ? "p-2" : "p-3"}`}>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-green-500" />
          <Label className="text-sm font-medium">Take Profit</Label>
        </div>
        <div className={compact ? "space-y-2" : "grid grid-cols-2 gap-3"}>
          <div>
            <Label className="text-xs text-muted-foreground">Multipliers (x from entry)</Label>
            <Input
              value={tpThresholds}
              onChange={(e) => handleThresholdsChange(e.target.value)}
              onBlur={handleBlur}
              placeholder="4, 10, 25, 100"
              className="mt-1"
              disabled={disabled}
              data-testid={`${prefix}input-tp-thresholds`}
            />
            <p className="text-xs text-muted-foreground mt-1">e.g. 4x, 10x, 25x, 100x</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">% to sell at each level</Label>
            <Input
              value={tpPercents}
              onChange={(e) => handlePercentsChange(e.target.value)}
              onBlur={handleBlur}
              placeholder="25, 25, 25, 25"
              className="mt-1"
              disabled={disabled}
              data-testid={`${prefix}input-tp-percents`}
            />
            {!thresholdsValid() && tpThresholds.length > 0 && (
              <p className="text-xs text-red-500 mt-1">Must match number of thresholds</p>
            )}
            {thresholdsValid() && percentsTotal() !== 100 && (
              <p className="text-xs text-amber-500 mt-1">
                Total: {percentsTotal()}% (typically sums to 100%)
              </p>
            )}
          </div>
        </div>
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
              onBlur={handleBlur}
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
          disabled={isSaving || disabled || !thresholdsValid()}
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
  const sl = values.stopLossPercent ?? DEFAULT_VALUES.stopLossPercent;
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  return (
    <div className={`text-xs text-muted-foreground space-y-1 ${className}`} data-testid={`${prefix}rule-summary`}>
      <div className="flex items-center gap-1">
        <TrendingUp className="h-3 w-3 text-green-500" />
        <span>
          Take-profit: {thresholds.map((t, i) => `${t}x→${percents[i] || 0}%`).join(", ")}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <TrendingDown className="h-3 w-3 text-red-500" />
        <span>Stop-loss: {sl}% ({values.stopLossMode || "auto"})</span>
      </div>
    </div>
  );
}
