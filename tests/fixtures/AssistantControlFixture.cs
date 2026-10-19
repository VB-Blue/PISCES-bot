using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
public class AssistantControlFixture {
  [STAThread] public static void Main(string[] args) {
    var app = new Application();
    var window = new Window { Title="Memory Assistant Control Fixture", Width=520, Height=300, Left=80, Top=100, Topmost=false };
    var panel = new StackPanel { Margin=new Thickness(24) };
    panel.Children.Add(new TextBlock { Text="专用测试窗口：没有用户文件", Margin=new Thickness(0,0,0,12) });
    var input = new TextBox { Name="InputField", Text="", Margin=new Thickness(0,0,0,12), Height=32 };
    AutomationProperties.SetAutomationId(input,"InputField"); AutomationProperties.SetName(input,"Test Input");
    var state = new TextBlock { Name="StateField", Text="Waiting", Margin=new Thickness(0,12,0,0) };
    AutomationProperties.SetAutomationId(state,"StateField");
    var button = new Button { Name="MarkDone", Content="Mark Done", Height=36 };
    AutomationProperties.SetAutomationId(button,"MarkDone");
    Action log = () => File.WriteAllText(args[0], input.Text+"\n"+state.Text);
    input.TextChanged += (s,e) => log();
    button.Click += (s,e) => { state.Text="Completed: "+input.Text; log(); };
    panel.Children.Add(input); panel.Children.Add(button); panel.Children.Add(state); window.Content=panel;
    window.Loaded += (s,e) => { log(); window.Activate(); input.Focus(); };
    app.Run(window);
  }
}
