// GUI launcher and install maintenance using the inbox Windows .NET Framework.
using System;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;
internal static class VoiceInvokerLauncher {
    public sealed class Entry { public string path { get; set; } public string sha256 { get; set; } }
    static string DataDir() {
        string dir=Environment.GetEnvironmentVariable("VI_DATA_DIR");
        return String.IsNullOrEmpty(dir)?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"VoiceInvoker"):dir;
    }
    static string Hash(string file) {
        using(var sha=SHA256.Create()) using(var stream=File.OpenRead(file))
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
    }
    static void NoReparse(string path) {
        try {if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse point: "+path);}
        catch(FileNotFoundException){} catch(DirectoryNotFoundException){}
    }
    static string SafePath(string root,string relative) {
        string prefix=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        if(String.IsNullOrEmpty(relative)||Path.IsPathRooted(relative)||relative.IndexOf(':')>=0)throw new IOException("Invalid package path");
        foreach(string part in relative.Split('\\','/'))if(part==""||part=="."||part=="..")throw new IOException("Invalid package path");
        string result=Path.GetFullPath(Path.Combine(prefix,relative));
        if(!result.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new IOException("Path escapes installation");
        string item=prefix.TrimEnd(Path.DirectorySeparatorChar);NoReparse(item);
        foreach(string part in relative.Split('\\','/')){item=Path.Combine(item,part);NoReparse(item);}
        return result;
    }
    static Entry[] Entries(string file) {
        var parser=new JavaScriptSerializer();parser.MaxJsonLength=16*1024*1024;
        var result=parser.Deserialize<Entry[]>(File.ReadAllText(file));
        if(result==null)throw new IOException("Invalid manifest");
        var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var e in result)if(e==null||String.IsNullOrEmpty(e.path)||e.sha256==null||!System.Text.RegularExpressions.Regex.IsMatch(e.sha256,"^[0-9a-f]{64}$")||!seen.Add(e.path.Replace('/','\\')))throw new IOException("Invalid package entry");
        return result;
    }
    static bool IsVoiceInvoker(string root) {
        string p=SafePath(root,"resources\\app\\package.json");if(!File.Exists(p))return false;
        try {var obj=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(p));return obj.ContainsKey("name")&&String.Equals(obj["name"] as string,"voice-invoke",StringComparison.Ordinal);}catch{return false;}
    }
    static void Backup(string file) {
        if(!File.Exists(file))return;
        string hash=Hash(file),dir=Path.Combine(DataDir(),"legacy-backups");Directory.CreateDirectory(dir);
        string target=Path.Combine(dir,Path.GetFileNameWithoutExtension(file)+"-"+hash+Path.GetExtension(file));
        if(!File.Exists(target))File.Copy(file,target,false);
        if(Hash(target)!=hash)throw new IOException("Could not verify legacy backup");
    }
    static void Prepare(string root,string work) {
        Directory.CreateDirectory(root);NoReparse(root);
        bool previous=IsVoiceInvoker(root);
        foreach(var e in Entries(Path.Combine(work,"package-manifest.json"))) {
            string target=SafePath(root,e.path);if(!File.Exists(target))continue;
            if(Hash(target)==e.sha256){
                string marker=SafePath(Path.Combine(work,"keep"),e.path);
                Directory.CreateDirectory(Path.GetDirectoryName(marker));File.WriteAllText(marker,"");
            }else if(!previous)throw new IOException("Existing unrelated file: "+e.path);
        }
        // Check the settings destination too, even though it is not a package file.
        string oldConfig=SafePath(root,"resources\\app\\config.json");
        if(!previous)return;
        File.WriteAllText(Path.Combine(work,"previous-install"),"1");
        Directory.CreateDirectory(DataDir());string config=Path.Combine(DataDir(),"config.json");
        if(File.Exists(oldConfig)){Backup(oldConfig);if(!File.Exists(config))File.Copy(oldConfig,config,false);}
        foreach(string name in new[]{".dota-install.json","log.txt","log.previous.txt","launcher.log","config.json.broken"})Backup(SafePath(root,"resources\\app\\"+name));
    }
    static void FinalizeInstall(string root,string work) {
        var current=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var e in Entries(Path.Combine(work,"package-manifest.json"))){
            string target=SafePath(root,e.path);
            if(!File.Exists(target)||Hash(target)!=e.sha256)throw new IOException("Installed file failed verification: "+e.path);
            current.Add(e.path.Replace('/','\\'));
        }
        string manifest=SafePath(root,"install-manifest.json");
        if(File.Exists(Path.Combine(work,"previous-install"))){
            // Only delete unchanged files belonging to an earlier package; never recursive deletion.
            if(File.Exists(manifest))foreach(var old in Entries(manifest)){
                string rel=old.path.Replace('/','\\');
                if(current.Contains(rel)||rel.Equals("resources\\app\\config.json",StringComparison.OrdinalIgnoreCase)||rel.StartsWith("resources\\app\\model\\",StringComparison.OrdinalIgnoreCase)||Path.GetFileName(rel).StartsWith(".",StringComparison.Ordinal)||!rel.StartsWith("resources\\app\\",StringComparison.OrdinalIgnoreCase))continue;
                string file=SafePath(root,rel);if(File.Exists(file)&&Hash(file)==old.sha256)File.Delete(file);
            }
            string bat=SafePath(root,"Start Voice Invoker.bat");
            if(File.Exists(bat)&&!current.Contains("Start Voice Invoker.bat")&&File.ReadAllText(bat).Replace("\r\n","\n").Trim()=="@echo off\ncall \"%~dp0resources\\app\\start.bat\"")File.Delete(bat);
            foreach(string name in new[]{"log.txt","log.previous.txt","launcher.log","config.json.broken"}){
                string old=SafePath(root,"resources\\app\\"+name);if(File.Exists(old)){Backup(old);File.Delete(old);}
            }
        }
        string temp=manifest+".new";NoReparse(temp);File.Copy(Path.Combine(work,"package-manifest.json"),temp,true);
        if(File.Exists(manifest))File.Replace(temp,manifest,null);else File.Move(temp,manifest);
    }
    static int Launch(string[] args){
        string root=AppDomain.CurrentDomain.BaseDirectory,app=Path.Combine(root,"resources","app"),exe=Path.Combine(root,"VoiceInvoker.exe");
        if(!File.Exists(exe)||!File.Exists(Path.Combine(app,"scripts","packaged-launch.js")))throw new IOException("Installation incomplete. Run the Installer to repair it.");
        Directory.CreateDirectory(DataDir());
        var psi=new ProcessStartInfo(exe,"scripts\\packaged-launch.js"+(Array.IndexOf(args,"--no-dota")>=0?" --no-dota":""));
        psi.WorkingDirectory=app;psi.UseShellExecute=false;psi.CreateNoWindow=true;
        psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1";psi.EnvironmentVariables["VI_PACKAGED"]="1";psi.EnvironmentVariables.Remove("ELECTRON_OVERRIDE_DIST_PATH");
        psi.RedirectStandardOutput=true;psi.RedirectStandardError=true;
        using(var log=new StreamWriter(new FileStream(Path.Combine(DataDir(),"launcher-startup.log"),FileMode.Append,FileAccess.Write,FileShare.ReadWrite)))using(var p=new Process()){
            log.AutoFlush=true;p.StartInfo=psi;object gate=new object();
            p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)lock(gate)log.WriteLine(e.Data);};
            p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)lock(gate)log.WriteLine(e.Data);};
            p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();return p.ExitCode;
        }
    }
    [STAThread] static int Main(string[] args){
        bool maintenance=args.Length==3&&(args[0]=="--prepare"||args[0]=="--finalize");
        try{
            if(maintenance){if(args[0]=="--prepare")Prepare(args[1],args[2]);else FinalizeInstall(args[1],args[2]);return 0;}
            int code=Launch(args);if(code!=0)throw new IOException("Startup failed. See launcher-startup.log in AppData.");return 0;
        }catch(Exception e){
            try{Directory.CreateDirectory(DataDir());File.AppendAllText(Path.Combine(DataDir(),maintenance?"installer.log":"launcher-startup.log"),DateTime.Now.ToString("s")+" "+e.Message+Environment.NewLine);}catch{}
            if(!maintenance&&String.IsNullOrEmpty(Environment.GetEnvironmentVariable("VI_LIFECYCLE_DIR")))MessageBox.Show(e.Message,"Voice Invoker",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        }
    }
}
