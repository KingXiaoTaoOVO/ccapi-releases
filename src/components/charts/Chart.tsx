import { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { useThemeStore } from "@/store/useThemeStore";

/**
 * 统一的 ECharts 包装。
 * - 自动随当前主题（light/dark）切换；
 * - 默认 transparent 背景，让外层 glass 卡片透出来；
 * - 高度由父级 className 决定（推荐外层加 h-64 / aspect-video 等）。
 */
export function Chart({
  option,
  className,
  notMerge = true,
  lazyUpdate = true,
  onEvents,
}: {
  option: EChartsOption;
  className?: string;
  notMerge?: boolean;
  lazyUpdate?: boolean;
  onEvents?: Record<string, (...args: unknown[]) => void>;
}) {
  const resolved = useThemeStore((s) => s.resolved);

  const themed = useMemo<EChartsOption>(() => {
    const textColor = resolved === "dark" ? "rgba(228,231,236,0.85)" : "rgba(40,46,56,0.85)";
    const axisLine = resolved === "dark" ? "rgba(228,231,236,0.18)" : "rgba(40,46,56,0.18)";
    const splitLine = resolved === "dark" ? "rgba(228,231,236,0.08)" : "rgba(40,46,56,0.08)";
    return {
      backgroundColor: "transparent",
      textStyle: { color: textColor, fontFamily: "inherit" },
      tooltip: {
        ...(option.tooltip as object),
        backgroundColor: resolved === "dark" ? "#15171c" : "#fff",
        borderColor: resolved === "dark" ? "#2b2e36" : "#e2e5eb",
        textStyle: { color: textColor },
      },
      legend: { textStyle: { color: textColor }, ...(option.legend as object) },
      grid: { left: 40, right: 16, top: 24, bottom: 28, containLabel: true, ...(option.grid as object) },
      xAxis: applyAxisStyle(option.xAxis, axisLine, splitLine, textColor),
      yAxis: applyAxisStyle(option.yAxis, axisLine, splitLine, textColor),
      ...option,
    };
  }, [option, resolved]);

  return (
    <ReactECharts
      option={themed}
      notMerge={notMerge}
      lazyUpdate={lazyUpdate}
      theme={resolved === "dark" ? "dark" : undefined}
      style={{ width: "100%", height: "100%" }}
      className={className}
      onEvents={onEvents}
    />
  );
}

function applyAxisStyle(
  axis: EChartsOption["xAxis"] | EChartsOption["yAxis"] | undefined,
  axisLine: string,
  splitLine: string,
  textColor: string,
) {
  if (!axis) return axis;
  const apply = (a: Record<string, unknown>) => ({
    ...a,
    axisLine: { lineStyle: { color: axisLine }, ...(a.axisLine as object) },
    axisLabel: { color: textColor, ...(a.axisLabel as object) },
    splitLine: { lineStyle: { color: splitLine }, ...(a.splitLine as object) },
  });
  if (Array.isArray(axis)) return axis.map((a) => apply(a as Record<string, unknown>));
  return apply(axis as Record<string, unknown>);
}
