' ===========================================================================
'  Email open tracker  -  paste into  ThisOutlookSession  (Alt+F11 in Outlook)
'  Outlook Classic for Windows only. "New Outlook" has no VBA.
' ===========================================================================

Private Const BASE As String = "https://email-tracker.YOURNAME.workers.dev"  ' your Worker URL, NO trailing slash
Private Const KEY As String = "PASTE_YOUR_SHARED_SECRET"                     ' must match the Worker's SHARED_SECRET
Private Const TRACK_ALL As Boolean = True            ' False = only track mails you tag with the "Track" category
Private Const CONVERT_PLAIN_TO_HTML As Boolean = True ' a pixel needs an HTML body

Private Sub Application_ItemSend(ByVal Item As Object, Cancel As Boolean)
    On Error Resume Next

    If Item.Class <> olMail Then Exit Sub
    Dim mail As Outlook.MailItem
    Set mail = Item

    If Not TRACK_ALL Then
        If InStr(1, "|" & Replace(mail.Categories, " ", "") & "|", "|Track|", vbTextCompare) = 0 Then Exit Sub
    End If

    If mail.BodyFormat <> olFormatHTML Then
        If CONVERT_PLAIN_TO_HTML Then
            mail.BodyFormat = olFormatHTML
        Else
            Exit Sub
        End If
    End If

    Randomize
    Dim id As String
    id = Format$(Now, "yyyymmdd-hhnnss") & "-" & Right$("000000" & CStr(Int(Rnd() * 1000000#)), 6)

    Dim recips As String, r As Outlook.Recipient
    For Each r In mail.Recipients
        recips = recips & r.Name & " <" & r.Address & ">; "
    Next

    ' --- tell the Worker about this message (best effort; a failure won't block the send) ---
    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 2000, 2000, 4000, 4000
    http.Open "POST", BASE & "/register", False
    http.setRequestHeader "Content-Type", "application/json"
    http.setRequestHeader "X-Track-Key", KEY
    http.send "{""id"":""" & id & """,""subject"":" & J(mail.Subject) & ",""to"":" & J(recips) & "}"

    ' --- inject the invisible pixel ---
    Dim px As String
    px = "<img src=""" & BASE & "/o/" & id & ".gif"" alt="""" width=""1"" height=""1"" " & _
         "style=""display:none !important;opacity:0;width:1px;height:1px;overflow:hidden;"" />"

    Dim hb As String
    hb = mail.HTMLBody
    If InStr(1, hb, "</body>", vbTextCompare) > 0 Then
        mail.HTMLBody = Replace(hb, "</body>", px & "</body>", 1, 1, vbTextCompare)
    Else
        mail.HTMLBody = hb & px
    End If
End Sub

' minimal JSON string encoder
Private Function J(ByVal s As String) As String
    s = Replace(s, "\", "\\")
    s = Replace(s, """", "\""")
    s = Replace(s, vbCr, " ")
    s = Replace(s, vbLf, " ")
    s = Replace(s, vbTab, " ")
    J = """" & s & """"
End Function
