param([Parameter(Mandatory=$true)][string]$Exe,[Parameter(Mandatory=$true)][string]$Png,[Parameter(Mandatory=$true)][string]$Ico)
$ErrorActionPreference='Stop'
# Update only PE icon resources in the copied, local build. The upstream
# Electron runtime in node_modules is never modified. The rebranded EXE is unsigned.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class VoiceInvokerIcon {
  delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr arg);
  delegate bool LangCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr arg);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string file,IntPtr unused,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll",EntryPoint="EnumResourceNamesW",SetLastError=true)] static extern bool EnumResourceNames(IntPtr module,IntPtr type,NameCallback callback,IntPtr arg);
  [DllImport("kernel32.dll",EntryPoint="EnumResourceLanguagesW",SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module,IntPtr type,IntPtr name,LangCallback callback,IntPtr arg);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string file,bool delete);
  [DllImport("kernel32.dll",EntryPoint="UpdateResourceW",SetLastError=true)] static extern bool UpdateResource(IntPtr update,IntPtr type,IntPtr name,ushort language,byte[] bytes,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool EndUpdateResource(IntPtr update,bool discard);
  [DllImport("kernel32.dll",EntryPoint="FindResourceExW",SetLastError=true)] static extern IntPtr FindResourceEx(IntPtr module,IntPtr type,IntPtr name,ushort language);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint SizeofResource(IntPtr module,IntPtr resource);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr LoadResource(IntPtr module,IntPtr resource);
  [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr data);
  static void Require(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Id(int value){return new IntPtr(value);}
  static byte[] Directory(byte[] png, int width, int height, int id, bool ico) {
    using(var ms=new MemoryStream()) using(var w=new BinaryWriter(ms)){
      w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)1);
      w.Write((byte)(width==256?0:width));w.Write((byte)(height==256?0:height));w.Write((byte)0);w.Write((byte)0);
      w.Write((ushort)1);w.Write((ushort)32);w.Write((uint)png.Length);
      if(ico){w.Write((uint)22);w.Write(png);}else w.Write((ushort)id);
      return ms.ToArray();
    }
  }
  static int Big(byte[] b,int at){return (b[at]<<24)|(b[at+1]<<16)|(b[at+2]<<8)|b[at+3];}
  static byte[] ReadResource(IntPtr h,int type,int id,ushort lang){
    var r=FindResourceEx(h,Id(type),Id(id),lang);Require(r!=IntPtr.Zero);
    var n=SizeofResource(h,r);Require(n>0&&n<=int.MaxValue);
    var data=LockResource(LoadResource(h,r));Require(data!=IntPtr.Zero);
    byte[] b=new byte[(int)n];Marshal.Copy(data,b,0,b.Length);return b;
  }
  static bool Equal(byte[] a,byte[] b){if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
  public static void Apply(string exe,string pngPath,string icoPath){
    byte[] png=File.ReadAllBytes(pngPath);
    if(png.Length<24||png[0]!=137||png[1]!=80||png[2]!=78||png[3]!=71)throw new InvalidDataException("Invalid icon PNG");
    int width=Big(png,16),height=Big(png,20);
    if(width<1||width>256||height<1||height>256)throw new InvalidDataException("Icon must fit 256 pixels");
    var groups=new List<KeyValuePair<int,ushort>>();var icons=new HashSet<int>();bool invalid=false;
    IntPtr h=LoadLibraryEx(exe,IntPtr.Zero,2);Require(h!=IntPtr.Zero);
    try {
      Require(EnumResourceNames(h,Id(14),delegate(IntPtr mod,IntPtr type,IntPtr name,IntPtr arg){
        if(name.ToInt64()>65535){invalid=true;return true;}
        int group=name.ToInt32();
        bool ok=EnumResourceLanguages(mod,type,name,delegate(IntPtr m,IntPtr t,IntPtr n,ushort lang,IntPtr a){groups.Add(new KeyValuePair<int,ushort>(group,lang));return true;},IntPtr.Zero);
        if(!ok)invalid=true;return true;
      },IntPtr.Zero));
      Require(EnumResourceNames(h,Id(3),delegate(IntPtr mod,IntPtr type,IntPtr name,IntPtr arg){if(name.ToInt64()<=65535)icons.Add(name.ToInt32());return true;},IntPtr.Zero));
    }finally{FreeLibrary(h);}
    if(invalid||groups.Count==0)throw new InvalidDataException("Unsupported or missing PE icon group");
    int id=30000;while(icons.Contains(id)&&id<65535)id++;
    if(icons.Contains(id))throw new InvalidDataException("No free icon resource ID");
    byte[] groupData=Directory(png,width,height,id,false);
    File.WriteAllBytes(icoPath,Directory(png,width,height,id,true));
    IntPtr update=BeginUpdateResource(exe,false);Require(update!=IntPtr.Zero);bool committed=false;
    try{
      var languages=new HashSet<ushort>();
      foreach(var g in groups){
        if(languages.Add(g.Value))Require(UpdateResource(update,Id(3),Id(id),g.Value,png,(uint)png.Length));
        Require(UpdateResource(update,Id(14),Id(g.Key),g.Value,groupData,(uint)groupData.Length));
      }
      bool ok=EndUpdateResource(update,false);update=IntPtr.Zero;Require(ok);committed=true;
    }finally{if(!committed&&update!=IntPtr.Zero)EndUpdateResource(update,true);}
    h=LoadLibraryEx(exe,IntPtr.Zero,2);Require(h!=IntPtr.Zero);
    try{foreach(var g in groups){
      if(!Equal(ReadResource(h,14,g.Key,g.Value),groupData)||!Equal(ReadResource(h,3,id,g.Value),png))throw new InvalidDataException("Icon resource verification failed");
    }}finally{FreeLibrary(h);}
  }
}
'@
[VoiceInvokerIcon]::Apply($Exe,$Png,$Ico)
Write-Host 'PASS: original Voice Invoker icon embedded and verified in executable resources'
