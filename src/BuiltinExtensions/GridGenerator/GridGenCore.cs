﻿using FreneticUtilities.FreneticExtensions;
using FreneticUtilities.FreneticToolkit;
using Newtonsoft.Json.Linq;
using StableSwarmUI.Core;
using StableSwarmUI.Text2Image;
using StableSwarmUI.Utils;
using System.IO;

namespace StableSwarmUI.Builtin_GridGeneratorExtension;

public partial class GridGenCore
{
    #region Local Settings
    public static string ASSETS_DIR;

    public static string EXTRA_FOOTER;

    public static List<string> EXTRA_ASSETS = new();

    public static Action<SingleGridCall, T2IParamInput, bool> GridCallApplyHook;

    public static Func<SingleGridCall, string, string, bool> GridCallParamAddHook;

    public static Action<GridRunner> GridRunnerPreRunHook, GridRunnerPreDryHook;

    public static Func<GridRunner, T2IParamInput, SingleGridCall, Task> GridRunnerPostDryHook;

    public static Action<SingleGridCall> GridCallInitHook;

    public static Action<GridRunner> PostPreprocessCallback;
    #endregion

    public static GridGeneratorExtension Extension;

    public static string EscapeHtml(string text)
    {
        return text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
    }

    public static string CleanForWeb(string text)
    {
        return text?.Replace("\"", "&quot;");
    }

    public static AsciiMatcher CleanIDMatcher = new(AsciiMatcher.LowercaseLetters + AsciiMatcher.Digits + "_");

    public static string CleanID(string id)
    {
        return CleanIDMatcher.TrimToMatches(id.ToLowerFast().Trim());
    }

    public static List<string> ExpandNumericListRanges(List<string> inList, Type numType)
    {
        List<string> outList = new();
        for (int i = 0; i < inList.Count; i++)
        {
            string rawVal = inList[i].Trim();
            if (rawVal == ".." || rawVal == "..." || rawVal == "....")
            {
                if (i < 2 || i + 1 >= inList.Count)
                {
                    throw new Exception($"Cannot use ellipses notation at index {i}/{inList.Count} - must have at least 2 values before and 1 after.");
                }
                double prior = double.Parse(outList[^1]);
                double doublePrior = double.Parse(outList[^2]);
                double after = double.Parse(inList[i + 1]);
                double step = prior - doublePrior;
                if ((step < 0) != ((after - prior) < 0))
                {
                    throw new Exception($"Ellipses notation failed for step {step} between {prior} and {after} - steps backwards.");
                }
                int count = (int)Math.Round((after - prior) / step);
                for (int x = 1; x < count; x++)
                {
                    double outVal = prior + x * step;
                    if (numType == typeof(int))
                    {
                        outVal = (int)Math.Round(outVal);
                    }
                    outList.Add($"{outVal:0.#}");
                }
            }
            else
            {
                outList.Add(rawVal);
            }
        }
        return outList;
    }

    public class AxisValue
    {
        public string Key;

        public Axis Axis;

        public Dictionary<string, string> Params = new();

        public bool Skip = false;

        public bool Show = true;

        public string Title, Description;

        public AxisValue(Grid grid, Axis axis, string key, string val)
        {
            Axis = axis;
            Key = CleanID(key);
            if (axis.Values.Any(x => x.Key == Key))
            {
                Key += $"__{axis.Values.Count}";
            }
            Params = new();
            string[] halves = val.Split('=', 2);
            if (halves.Length != 2)
            {
                throw new Exception($"Invalid value '{key}': '{val}': not expected format");
            }
            //halves[0] = grid.ProcVariables(halves[0]);
            //halves[1] = grid.ProcVariables(halves[1]);
            //halves[1] = ValidateSingleParam(halves[0], halves[1]);
            Title = halves[1];
            Params[T2IParamTypes.CleanTypeName(halves[0])] = halves[1];
        }
    }

    public class Axis
    {
        public string RawID, ID;

        public List<AxisValue> Values = new();

        public string Title, Description = "";

        public string DefaultID;

        public string ModeName;

        public T2IParamType Mode;

        public void BuildFromListStr(string id, Grid grid, string listStr)
        {
            RawID = id;
            ID = CleanID(id);
            Title = RawID;
            bool isSplitByDoublePipe = listStr.Contains("||");
            List<string> valuesList = listStr.Split(isSplitByDoublePipe ? "||" : ",").ToList();
            ModeName = T2IParamTypes.CleanNameGeneric(id);
            if (!T2IParamTypes.TryGetType(T2IParamTypes.CleanTypeName(ModeName), out Mode, grid.InitialParams))
            {
                throw new Exception($"Invalid axis mode '{Mode}' from '{id}': unknown mode");
            }
            if (Mode.Type == T2IParamDataType.INTEGER)
            {
                valuesList = ExpandNumericListRanges(valuesList, typeof(int));
            }
            else if (Mode.Type == T2IParamDataType.DECIMAL)
            {
                valuesList = ExpandNumericListRanges(valuesList, typeof(float));
            }
            int index = 0;
            if (Mode.ParseList != null)
            {
                valuesList = Mode.ParseList(valuesList);
            }
            foreach (string val in valuesList)
            {
                try
                {
                    string valStr = val.Trim();
                    index++;
                    if (isSplitByDoublePipe && valStr == "" && index == valuesList.Count)
                    {
                        continue;
                    }
                    valStr = T2IParamTypes.ValidateParam(Mode, valStr, grid.InitialParams.SourceSession);
                    Values.Add(new AxisValue(grid, this, index.ToString(), $"{id}={valStr}"));
                }
                catch (InvalidDataException ex)
                {
                    throw new InvalidDataException($"value '{val}' errored: {ex.Message}");
                }
                catch (Exception ex)
                {
                    throw new Exception($"value '{val}' errored: {ex}");
                }
            }
        }
    }

    public class Grid
    {
        // TODO: Variables

        public List<Axis> Axes = new();

        public string Title, Description, Author;

        public string Format;

        public Dictionary<string, string> BaseParams = new();

        public int MinWidth, MinHeight;

        public bool Autoscale = false, ShowDescriptions = true, Sticky = false, StickyLabels = true;

        public string DefaultX, DefaultY, DefaultX2 = "none", DefaultY2 = "none";

        public List<(string, DateTimeOffset)> LastUpdates = new(); // TODO: rework to just use the server instead of this legacy trick (holdover from python version)

        public LockObject LastUpdatLock = new();

        public T2IParamInput InitialParams;

        public object LocalData;

        public GridRunner Runner;

        public volatile bool MustCancel;

        public bool PublishMetadata;
    }

    public class SingleGridCall
    {
        public List<AxisValue> Values = new();

        public bool Skip;

        public string BaseFilepath;

        public string Data;

        public Dictionary<string, string> Params;

        public object LocalData;

        public Grid Grid;

        public SingleGridCall(Grid grid, List<AxisValue> values)
        {
            Grid = grid;
            Values = values;
            Skip = values.Any(v => v.Skip);
            GridCallInitHook?.Invoke(this);
        }

        public void BuildBasePaths()
        {
            BaseFilepath = string.Join("/", Values.Select(v => T2IParamTypes.CleanNameGeneric(v.Key)).Reverse());
            Data = string.Join(", ", Values.Select(v => $"{v.Axis.Title}={v.Title}"));
            Skip = Skip || (!Grid.Runner.DoOverwrite && File.Exists($"{Grid.Runner.BasePath}/{BaseFilepath}.{Grid.Format}"));
        }

        public void FlattenParams(Grid grid)
        {
            Params = new Dictionary<string, string>(grid.BaseParams);
            foreach (AxisValue val in Values)
            {
                foreach (KeyValuePair<string, string> pair in val.Params)
                {
                    if (GridCallParamAddHook == null || !GridCallParamAddHook(this, pair.Key, pair.Value))
                    {
                        Params[pair.Key] = pair.Value;
                    }
                }
            }
        }

        public void ApplyTo(T2IParamInput p, bool dry)
        {
            foreach (KeyValuePair<string, string> pair in Params)
            {
                T2IParamType mode = T2IParamTypes.GetType(pair.Key, p);
                p.Set(mode, pair.Value);
            }
            GridCallApplyHook?.Invoke(this, p, dry);
        }
    }

    public class GridRunner
    {
        public Grid Grid;

        public bool DoOverwrite;

        public string BasePath;

        public string URLBase;

        public T2IParamInput Params;

        public bool FastSkip;

        public int TotalRun = 0, TotalSkip = 0, TotalSteps = 0;

        public List<SingleGridCall> Sets;

        public int Iteration = 0;

        public void UpdateLiveFile(string newFile)
        {
            lock (Grid.LastUpdatLock)
            {
                DateTimeOffset tNow = DateTimeOffset.Now;
                Grid.LastUpdates = Grid.LastUpdates.Where(x => (tNow - x.Item2).TotalSeconds < 20).ToList();
                Grid.LastUpdates.Add((newFile, tNow));
                File.WriteAllText(BasePath + "/last.js", $"window.lastUpdated = [\"{string.Join("\", \"", Grid.LastUpdates.Select(p => p.Item1))}\"]");
            }
        }

        public List<SingleGridCall> BuildValueSetList(List<Axis> axisList)
        {
            if (axisList.Count == 0)
            {
                return new();
            }
            Axis curAxis = axisList[0];
            if (axisList.Count == 1)
            {
                return curAxis.Values.Where(v => !v.Skip || !FastSkip).Select(v => new SingleGridCall(Grid, new() { v })).ToList();
            }
            List<SingleGridCall> result = new();
            List<Axis> nextAxisList = axisList.GetRange(1, axisList.Count - 1);
            foreach (SingleGridCall obj in BuildValueSetList(nextAxisList))
            {
                foreach (AxisValue val in curAxis.Values)
                {
                    if (!val.Skip || !FastSkip)
                    {
                        List<AxisValue> newList = obj.Values.ToList();
                        newList.Add(val);
                        result.Add(new SingleGridCall(Grid, newList));
                    }
                }
            }
            return result;
        }

        public void Preprocess()
        {
            if (!Directory.Exists(BasePath))
            {
                Directory.CreateDirectory(BasePath);
            }
            Sets = BuildValueSetList(Grid.Axes.ToList());
            Logs.Info($"Have {Sets.Count} unique value sets, will go into {BasePath}");
            foreach (SingleGridCall set in Sets)
            {
                set.BuildBasePaths();
                set.FlattenParams(Grid);
                if (set.Skip)
                {
                    TotalSkip++;
                }
                else
                {
                    TotalRun++;
                    int steps = Params.Get(T2IParamTypes.Steps);
                    if (set.Params.TryGetValue("steps", out string stepStr) && int.TryParse(stepStr, out int stepInt))
                    {
                        steps = stepInt;
                    }
                    TotalSteps += steps;
                }
            }
            Logs.Info($"Skipped {TotalSkip} files, will run {TotalRun} files, for {TotalSteps} total steps");
            PostPreprocessCallback?.Invoke(this);
        }

        public void Run(bool dry)
        {
            GridRunnerPreRunHook?.Invoke(this);
            Iteration = 0;
            foreach (SingleGridCall set in Sets)
            {
                if (set.Skip)
                {
                    continue;
                }
                if (Grid.MustCancel)
                {
                    return;
                }
                Iteration++;
                if (!dry)
                {
                    Logs.Debug($"Pre-prepping {Iteration}/{TotalRun} ... Set: {set.Data}, file {set.BaseFilepath}");
                }
                T2IParamInput p = Params.Clone();
                GridRunnerPreDryHook?.Invoke(this);
                set.ApplyTo(p, dry);
                if (dry)
                {
                    continue;
                }
                try
                {
                    GridRunnerPostDryHook(this, p, set).ContinueWith(_ =>
                    {
                        UpdateLiveFile($"{URLBase}/{set.BaseFilepath}.{Grid.Format}");
                    });
                }
                catch (FileNotFoundException e)
                {
                    // TODO: actual handler for this (this check is yoinked from python version)
                    if (e.Message == "The filename or extension is too long" && e.HResult == 206)
                    {
                        Logs.Error("\n\n\nOS Error: The filename or extension is too long - see this article to fix that: https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/The-Windows-10-default-path-length-limitation-MAX-PATH-is-256-characters.html \n\n\n");
                    }
                    throw e;
                }
            }
        }

        public string BuildJson(T2IParamInput inputs, bool dryRun)
        {
            JObject results = new()
            {
                ["title"] = Grid.Title,
                ["description"] = Grid.Description,
                ["ext"] = Grid.Format,
                ["min_width"] = Grid.MinWidth,
                ["min_height"] = Grid.MinHeight,
                ["defaults"] = new JObject()
                {
                    ["show_descriptions"] = Grid.ShowDescriptions,
                    ["autoscale"] = Grid.Autoscale,
                    ["sticky"] = Grid.Sticky,
                    ["sticky_labels"] = Grid.StickyLabels,
                    ["x"] = Grid.DefaultX,
                    ["y"] = Grid.DefaultY,
                    ["x2"] = Grid.DefaultX2,
                    ["y2"] = Grid.DefaultY2
                }
            };
            if (!dryRun)
            {
                results["will_run"] = true;
            }
            if (Grid.PublishMetadata)
            {
                results["metadata"] = null; // TODO: webdata_get_base_param_data(p)
            }
            JArray axes = new();
            foreach (Axis axis in Grid.Axes)
            {
                JObject jAxis = new()
                {
                    ["id"] = axis.ID,
                    ["title"] = axis.Title,
                    ["description"] = axis.Description ?? ""
                };
                JArray values = new();
                foreach (AxisValue val in axis.Values)
                {
                    JObject jVal = new()
                    {
                        ["key"] = val.Key.ToLowerFast(),
                        ["title"] = val.Title,
                        ["description"] = val.Description ?? "",
                        ["show"] = val.Show
                    };
                    if (Grid.PublishMetadata)
                    {
                        jVal["params"] = JToken.FromObject(val.Params);
                    }
                    values.Add(jVal);
                }
                jAxis["values"] = values;
                axes.Add(jAxis);
            }
            results["axes"] = axes;
            return results.ToString();
        }

        public string RadioButtonHtml(string name, string id, string descrip, string label)
        {
            return $"<input type=\"radio\" class=\"btn-check\" name=\"{name}\" id=\"{id.ToLowerFast()}\" autocomplete=\"off\" checked=\"\"><label class=\"btn btn-outline-primary\" for=\"{id.ToLowerFast()}\" title=\"{descrip}\">{EscapeHtml(label)}</label>\n";
        }

        public string AxisBar(string label, string content)
        {
            return $"<br><div class=\"btn-group\" role=\"group\" aria-label=\"Basic radio toggle button group\">{label}:&nbsp;\n{content}</div>\n";
        }

        public string BuildHtml(string footerExtra)
        {
            string html = File.ReadAllText($"{ASSETS_DIR}/page.html");
            string xSelect = "";
            string ySelect = "";
            string x2Select = RadioButtonHtml("x2_axis_selector", "x2_none", "None", "None");
            string y2Select = RadioButtonHtml("y2_axis_selector", "y2_none", "None", "None");
            string content = "<div style=\"margin: auto; width: fit-content;\"><table class=\"sel_table\">\n";
            string advancedSettings = "";
            bool primary = true;
            foreach (Axis axis in Grid.Axes)
            {
                try
                {
                    string axisDescrip = CleanForWeb(axis.Description ?? "");
                    string trClass = primary ? "primary" : "secondary";
                    content += $"<tr class=\"{trClass}\">\n<td>\n<h4>{EscapeHtml(axis.Title)}</h4>\n";
                    advancedSettings += $"\n<h4>{axis.Title}</h4><div class=\"timer_box\">Auto cycle every <input style=\"width:30em;\" autocomplete=\"off\" type=\"range\" min=\"0\" max=\"360\" value=\"0\" class=\"form-range timer_range\" id=\"range_tablist_{axis.ID}\"><label class=\"form-check-label\" for=\"range_tablist_{axis.ID}\" id=\"label_range_tablist_{axis.ID}\">0 seconds</label></div>\nShow value: ";
                    string axisClass = "axis_table_cell";
                    if (axisDescrip.Trim().Length == 0)
                    {
                        axisClass += " emptytab";
                    }
                    content += $"<div class=\"{axisClass}\">{axisDescrip}</div></td>\n<td><ul class=\"nav nav-tabs\" role=\"tablist\" id=\"tablist_{axis.ID}\">\n";
                    primary = !primary;
                    bool isFirst = axis.DefaultID is null;
                    foreach (AxisValue val in axis.Values)
                    {
                        if (axis.DefaultID is not null)
                        {
                            isFirst = axis.DefaultID == val.Key;
                        }
                        string selected = isFirst ? "true" : "false";
                        string active = isFirst ? " active" : "";
                        isFirst = false;
                        string descrip = CleanForWeb(val.Description ?? "");
                        content += $"<li class=\"nav-item\" role=\"presentation\"><a class=\"nav-link{active}\" data-bs-toggle=\"tab\" href=\"#tab_{axis.ID}__{val.Key}\" id=\"clicktab_{axis.ID}__{val.Key}\" aria-selected=\"{selected}\" role=\"tab\" title=\"{EscapeHtml(val.Title)}: {descrip}\">{EscapeHtml(val.Title)}</a></li>\n";
                        advancedSettings += $"&nbsp;<input class=\"form-check-input\" type=\"checkbox\" autocomplete=\"off\" id=\"showval_{axis.ID}__{val.Key}\" checked=\"true\" onchange=\"javascript:toggleShowVal('{axis.ID}', '{val.Key}')\"> <label class=\"form-check-label\" for=\"showval_{axis.ID}__{val.Key}\" title=\"Uncheck this to hide '{val.Title}' from the page.\">{val.Title}</label>";
                    }
                    advancedSettings += $"&nbsp;&nbsp;<button class=\"submit\" onclick=\"javascript:toggleShowAllAxis('{axis.ID}')\">Toggle All</button>";
                    content += "</ul>\n<div class=\"tab-content\">\n";
                    isFirst = axis.DefaultID is null;
                    foreach (AxisValue val in axis.Values)
                    {
                        if (axis.DefaultID is not null)
                        {
                            isFirst = axis.DefaultID == val.Key;
                        }
                        string active = isFirst ? " active show" : "";
                        isFirst = false;
                        string descrip = CleanForWeb(val.Description ?? "");
                        if (descrip.Trim().Length == 0)
                        {
                            active += " emptytab";
                        }
                        content += $"<div class=\"tab-pane{active}\" id=\"tab_{axis.ID}__{val.Key}\" role=\"tabpanel\"><div class=\"tabval_subdiv\">{descrip}</div></div>\n";
                    }
                    content += "</div></td></tr>\n";
                    xSelect += RadioButtonHtml("x_axis_selector", $"x_{axis.ID}", axisDescrip, axis.Title);
                    ySelect += RadioButtonHtml("y_axis_selector", $"y_{axis.ID}", axisDescrip, axis.Title);
                    x2Select += RadioButtonHtml("x2_axis_selector", $"x2_{axis.ID}", axisDescrip, axis.Title);
                    y2Select += RadioButtonHtml("y2_axis_selector", $"y2_{axis.ID}", axisDescrip, axis.Title);
                }
                catch (Exception ex)
                {
                    throw new Exception($"Failed to build HTML for axis '{axis.ID}': {ex}");
                }
            }
            content += "</table>\n<div class=\"axis_selectors\">";
            content += AxisBar("X Axis", xSelect);
            content += AxisBar("Y Axis", ySelect);
            content += AxisBar("X Super-Axis", x2Select);
            content += AxisBar("Y Super-Axis", y2Select);
            content += "</div></div>\n";
            html = html.Replace("{TITLE}", Grid.Title).Replace("{CLEAN_DESCRIPTION}", CleanForWeb(Grid.Description ?? "")).Replace("{DESCRIPTION}", Grid.Description ?? "")
                .Replace("{CONTENT}", content).Replace("{ADVANCED_SETTINGS}", advancedSettings).Replace("{AUTHOR}", Grid.Author).Replace("{EXTRA_FOOTER}", EXTRA_FOOTER + footerExtra).Replace("{VERSION}", Utilities.Version);
            return html;
        }

        public string EmitWebData(string path, T2IParamInput input, bool dryRun, string footerExtra)
        {
            Logs.Info("Building final web data...");
            string json = BuildJson(input, dryRun);
            if (!dryRun)
            {
                File.WriteAllText(path + "/last.js", "window.lastUpdated = []");
            }
            File.WriteAllText(path + "/data.js", "rawData = " + json);
            foreach (string f in EXTRA_ASSETS.Union(new string[] { "bootstrap.min.css", "bootstrap.bundle.min.js", "proc.js", "jquery.min.js", "jsgif.js", "styles.css", "placeholder.png" }))
            {
                string target = $"{path}/{f}";
                if (File.Exists(target))
                {
                    File.Delete(target);
                }
                File.Copy($"{ASSETS_DIR}/{f}", target);
            }
            string html = BuildHtml(footerExtra);
            File.WriteAllText(path + "/index.html", html);
            Logs.Info($"Web file is now at {path}/index.html");
            return json;
        }
    }

    // TODO: Clever model logic switching so this doesn't spam-switch

    public static Grid Run(T2IParamInput baseParams, JToken axes, object LocalData, string inputFile, string outputFolderBase, string urlBase, string outputFolderName, bool doOverwrite, bool fastSkip, bool generatePage, bool publishGenMetadata, bool dryRun, string footerExtra = "")
    {
        Grid grid = new()
        {
            Title = outputFolderName,
            Description = "",
            Author = "Unspecified",
            Format = "png",
            Axes = new(),
            BaseParams = new(),
            InitialParams = baseParams.Clone(),
            LocalData = LocalData,
            PublishMetadata = publishGenMetadata
        };
        foreach (JToken axis in axes)
        {
            string id = axis["mode"].ToString().ToLowerFast().Trim();
            if (id != "")
            {
                try
                {
                    id = CleanID(id);
                    string rawid = id;
                    int c = 1;
                    while (grid.Axes.Any(a => a.ID == id))
                    {
                        id = $"{rawid}_{c}";
                        c++;
                    }
                    Axis newAxis = new();
                    newAxis.BuildFromListStr(id, grid, axis["vals"].ToString());
                    grid.Axes.Add(newAxis);
                }
                catch (InvalidDataException ex)
                {
                    throw new InvalidDataException($"Invalid axis '{id}': {ex.Message}");
                }
                catch (Exception ex)
                {
                    throw new Exception($"Invalid axis '{id}': errored: {ex}");
                }
            }
        }
        grid.DefaultX = grid.Axes[0].ID;
        grid.DefaultY = grid.Axes[^1].ID;
        if (outputFolderName.Trim() == "")
        {
            outputFolderName = inputFile.Replace(".yml", "");
        }
        string folder = $"{outputFolderBase}/{outputFolderName}";
        GridRunner runner = new()
        {
            Grid = grid,
            DoOverwrite = doOverwrite,
            BasePath = folder,
            URLBase = urlBase + "/" + outputFolderName,
            Params = baseParams,
            FastSkip = fastSkip
        };
        grid.Runner = runner;
        runner.Preprocess();
        string json = "";
        if (generatePage)
        {
            json = runner.EmitWebData(folder, baseParams, dryRun, footerExtra);
        }
        runner.Run(dryRun);
        if (dryRun)
        {
            Logs.Info("Grid Generator dry run succeeded without error");
        }
        else if (generatePage)
        {
            json = json.Replace("\"will_run\": true, ", "");
            File.WriteAllText(folder + "/data.js", "rawData = " + json);
        }
        return grid;
    }

    public static void PostClean(string outputFolderBase, string outputFolderName)
    {
        string folder = $"{outputFolderBase}/{outputFolderName}";
        Task.Run(() =>
        {
            try
            {
                Task.Delay(6000).Wait(Program.GlobalProgramCancel);
            }
            catch (Exception ex)
            {
                Logs.Debug($"Error in GridGen wait-to-clear-last: {ex}");
            }
            finally
            {
                try
                {
                    File.Delete(folder + "/last.js");
                }
                catch (Exception ex)
                {
                    Logs.Debug($"Error in GridGen delete-last: {ex}");
                }
            }
        });
    }
}
